import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import {
  Alarm,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  MathExpression,
  Metric,
  SingleValueWidget,
  TreatMissingData,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { METRICS_SERVICE, metricsNamespace } from '../../packages/core/src/observability.js';
import { QUEUE_PROVIDERS, type QueueProvider } from './jobs_stack.js';
import type { StageConfig } from './stage_config.js';

/** Budget alerts as a percentage of the monthly budget (tech design 11). */
export const BUDGET_THRESHOLDS = [50, 80, 100] as const;

/** The app 5xx alarm fires when over 1% of requests fail, for 3 periods of 5 minutes running. */
export const APP_5XX_PERCENT_THRESHOLD = 1;

/** Job alarms (tech design 11): failure rate over 15 minutes, p95 provider latency, oldest queued message. */
export const FAILURE_RATE_PERCENT_THRESHOLD = 5;
export const P95_LATENCY_THRESHOLD_MS = 60_000;
export const OLDEST_MESSAGE_THRESHOLD_SECONDS = 5 * 60;

/** The worker's month-to-date spend gauge, published after each job with a provider cost. */
export const MONTHLY_SPEND_METRIC = 'MonthlySpendCents';

/** Cost allocation tag that splits the budget by environment; it must be activated in Billing once. */
export const ENVIRONMENT_TAG = 'environment';

export interface MonitoringStackProps extends StackProps {
  readonly config: StageConfig;
  readonly appFunction: IFunction;
  /** The `Jobs` stack's shared dead-letter queue. */
  readonly deadLetterQueue: IQueue;
  /** The provider queues and the purge queue, for depth and age. */
  readonly queues: Record<QueueProvider, IQueue>;
  readonly purgeQueue: IQueue;
  /** The daily model health check, whose errors count as a model health failure. */
  readonly modelHealthFunction: IFunction;
}

/**
 * Observability for one environment (tech design 11): the alert topic, the `pictora-<env>` dashboard, alarms
 * to email (failure rate, p95 provider latency, dead-letter queue, oldest queued message, app 5xx, model
 * health), and the AWS budget.
 */
export class MonitoringStack extends Stack {
  readonly alertTopic: Topic;
  readonly app5xxAlarm: Alarm;
  readonly deadLetterAlarm: Alarm;
  readonly failureRateAlarm: Alarm;
  readonly latencyAlarms: Alarm[];
  readonly oldestMessageAlarms: Alarm[];
  readonly modelHealthAlarm: Alarm;
  readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.alertTopic = new Topic(this, 'AlertTopic', {
      topicName: `pictora-${config.envName}-alerts`,
      displayName: `Pictora ${config.envName} alerts`,
      enforceSSL: true,
    });
    if (config.alertEmail) {
      this.alertTopic.addSubscription(new EmailSubscription(config.alertEmail));
    }

    const functionName = props.appFunction.functionName;
    const urlMetric = (metricName: string) =>
      new Metric({
        namespace: 'AWS/Lambda',
        metricName,
        dimensionsMap: { FunctionName: functionName },
        statistic: 'Sum',
        period: Duration.minutes(5),
      });
    this.app5xxAlarm = new Alarm(this, 'App5xxAlarm', {
      alarmName: `pictora-${config.envName}-app-5xx`,
      alarmDescription: `Over ${APP_5XX_PERCENT_THRESHOLD}% of app requests returned 5xx`,
      metric: new MathExpression({
        expression: 'IF(requests > 0, 100 * errors / requests, 0)',
        usingMetrics: { errors: urlMetric('Url5xxCount'), requests: urlMetric('UrlRequestCount') },
        label: 'App 5xx %',
        period: Duration.minutes(5),
      }),
      threshold: APP_5XX_PERCENT_THRESHOLD,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    this.app5xxAlarm.addAlarmAction(new SnsAction(this.alertTopic));
    this.app5xxAlarm.addOkAction(new SnsAction(this.alertTopic));

    // A message lands here after failing 3 receives; any at all needs a look.
    this.deadLetterAlarm = new Alarm(this, 'DeadLetterAlarm', {
      alarmName: `pictora-${config.envName}-dlq`,
      alarmDescription: 'Job messages are in the dead-letter queue',
      metric: props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    this.deadLetterAlarm.addAlarmAction(new SnsAction(this.alertTopic));
    this.deadLetterAlarm.addOkAction(new SnsAction(this.alertTopic));

    const alarmAction = new SnsAction(this.alertTopic);
    const namespace = metricsNamespace(config.envName);
    const pictoraMetric = (
      metricName: string,
      statistic: string,
      period: Duration,
      dimensions: Record<string, string> = {},
    ) =>
      new Metric({
        namespace,
        metricName,
        dimensionsMap: { service: METRICS_SERVICE, ...dimensions },
        statistic,
        period,
      });
    const jobCounts = (period: Duration) => ({
      created: pictoraMetric('JobsCreated', 'Sum', period),
      succeeded: pictoraMetric('JobsSucceeded', 'Sum', period),
      failed: pictoraMetric('JobsFailed', 'Sum', period),
      blocked: pictoraMetric('JobsBlocked', 'Sum', period),
    });
    const failureRate = (period: Duration) => {
      const { succeeded, failed, blocked } = jobCounts(period);
      return new MathExpression({
        expression:
          'IF(FILL(s, 0) + FILL(f, 0) + FILL(b, 0) > 0,' +
          ' 100 * FILL(f, 0) / (FILL(s, 0) + FILL(f, 0) + FILL(b, 0)), 0)',
        usingMetrics: { s: succeeded, f: failed, b: blocked },
        label: 'Failed jobs %',
        period,
      });
    };

    this.failureRateAlarm = new Alarm(this, 'FailureRateAlarm', {
      alarmName: `pictora-${config.envName}-failure-rate`,
      alarmDescription: `Over ${FAILURE_RATE_PERCENT_THRESHOLD}% of finished jobs failed in 15 minutes`,
      metric: failureRate(Duration.minutes(15)),
      threshold: FAILURE_RATE_PERCENT_THRESHOLD,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const latency = (provider: QueueProvider, statistic: string, period: Duration) =>
      pictoraMetric('ProviderLatencyMs', statistic, period, { provider });
    this.latencyAlarms = QUEUE_PROVIDERS.map(
      (provider) =>
        new Alarm(this, `${capitalize(provider)}LatencyAlarm`, {
          alarmName: `pictora-${config.envName}-${provider}-p95-latency`,
          alarmDescription: `p95 ${provider} latency was over ${P95_LATENCY_THRESHOLD_MS / 1000} s for 15 minutes`,
          metric: latency(provider, 'p95', Duration.minutes(15)),
          threshold: P95_LATENCY_THRESHOLD_MS,
          comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }),
    );

    const watchedQueues: [string, IQueue][] = [
      ...QUEUE_PROVIDERS.map((provider): [string, IQueue] => [provider, props.queues[provider]]),
      ['purge', props.purgeQueue],
    ];
    this.oldestMessageAlarms = watchedQueues.map(
      ([name, queue]) =>
        new Alarm(this, `${capitalize(name)}OldestMessageAlarm`, {
          alarmName: `pictora-${config.envName}-${name}-oldest-message`,
          alarmDescription: `A message has waited in the ${name} queue for over ${OLDEST_MESSAGE_THRESHOLD_SECONDS / 60} minutes`,
          metric: queue.metricApproximateAgeOfOldestMessage({
            statistic: 'Maximum',
            period: Duration.minutes(5),
          }),
          threshold: OLDEST_MESSAGE_THRESHOLD_SECONDS,
          comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }),
    );

    // A problem the check found, or the check itself failing, both need a look.
    this.modelHealthAlarm = new Alarm(this, 'ModelHealthAlarm', {
      alarmName: `pictora-${config.envName}-model-health`,
      alarmDescription:
        'A registered model is missing at its provider, deprecated, or retires within 60 days, or the check failed. ' +
        'The model_health logs name the model.',
      metric: new MathExpression({
        expression: 'FILL(problems, 0) + FILL(errors, 0)',
        usingMetrics: {
          problems: pictoraMetric('ModelHealthProblems', 'Maximum', Duration.days(1)),
          errors: props.modelHealthFunction.metricErrors({
            statistic: 'Sum',
            period: Duration.days(1),
          }),
        },
        label: 'Model health problems',
        period: Duration.days(1),
      }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    for (const alarm of [
      this.failureRateAlarm,
      ...this.latencyAlarms,
      ...this.oldestMessageAlarms,
      this.modelHealthAlarm,
    ]) {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    }

    const fiveMinutes = Duration.minutes(5);
    const counts = jobCounts(fiveMinutes);
    const queueWidget = (title: string, metric: (queue: IQueue) => IMetric) =>
      new GraphWidget({
        title,
        width: 8,
        left: watchedQueues.map(([name, queue]) =>
          (metric(queue) as Metric).with({
            label: name,
            statistic: 'Maximum',
            period: fiveMinutes,
          }),
        ),
      });
    this.dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: `pictora-${config.envName}`,
      widgets: [
        [
          new GraphWidget({
            title: 'Jobs by status',
            width: 8,
            left: [
              counts.created.with({ label: 'Created' }),
              counts.succeeded.with({ label: 'Succeeded' }),
              counts.failed.with({ label: 'Failed' }),
              counts.blocked.with({ label: 'Blocked' }),
            ],
          }),
          new GraphWidget({
            title: 'Job error rate (%)',
            width: 8,
            left: [failureRate(fiveMinutes)],
            leftAnnotations: [{ value: FAILURE_RATE_PERCENT_THRESHOLD, label: 'Alarm' }],
          }),
          new GraphWidget({
            title: 'App 5xx (%)',
            width: 8,
            left: [this.app5xxAlarm.metric],
            leftAnnotations: [{ value: APP_5XX_PERCENT_THRESHOLD, label: 'Alarm' }],
          }),
        ],
        [
          new GraphWidget({
            title: 'Provider latency p50 (ms)',
            width: 12,
            left: QUEUE_PROVIDERS.map((provider) =>
              latency(provider, 'p50', fiveMinutes).with({ label: provider }),
            ),
          }),
          new GraphWidget({
            title: 'Provider latency p95 (ms)',
            width: 12,
            left: QUEUE_PROVIDERS.map((provider) =>
              latency(provider, 'p95', fiveMinutes).with({ label: provider }),
            ),
            leftAnnotations: [{ value: P95_LATENCY_THRESHOLD_MS, label: 'Alarm' }],
          }),
        ],
        [
          queueWidget('Queue depth', (queue) => queue.metricApproximateNumberOfMessagesVisible()),
          queueWidget('Oldest message age (s)', (queue) =>
            queue.metricApproximateAgeOfOldestMessage(),
          ),
          new GraphWidget({
            title: 'Dead-letter queue depth',
            width: 8,
            left: [this.deadLetterAlarm.metric],
          }),
        ],
        [
          new SingleValueWidget({
            title: 'Spend today (cents)',
            width: 8,
            metrics: [pictoraMetric('ProviderCostCents', 'Sum', Duration.days(1))],
          }),
          new SingleValueWidget({
            title: 'Spend this month (cents)',
            width: 8,
            // The worker's gauge has no dimensions, unlike the Powertools metrics.
            metrics: [
              new Metric({
                namespace,
                metricName: MONTHLY_SPEND_METRIC,
                statistic: 'Maximum',
                period: Duration.days(1),
              }),
            ],
          }),
          new SingleValueWidget({
            title: 'Points reserved today',
            width: 8,
            metrics: [pictoraMetric('PointsReserved', 'Sum', Duration.days(1))],
          }),
        ],
      ],
    });

    this.alertTopic.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowBudgetsToPublish',
        principals: [new ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alertTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    new CfnBudget(this, 'Budget', {
      budget: {
        budgetName: `pictora-${config.envName}`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.budgetUsd, unit: 'USD' },
        costFilters: { TagKeyValue: [`user:${ENVIRONMENT_TAG}$${config.envName}`] },
      },
      notificationsWithSubscribers: BUDGET_THRESHOLDS.map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold,
          thresholdType: 'PERCENTAGE',
        },
        subscribers: [{ subscriptionType: 'SNS', address: this.alertTopic.topicArn }],
      })),
    });
  }
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
