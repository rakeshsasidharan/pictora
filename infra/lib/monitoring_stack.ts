import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  Metric,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import {
  MONTHLY_SPEND_METRIC,
  SPEND_ALARM_PERCENTS,
  metricsNamespace,
} from '../../packages/core/src/platform_cap.js';
import type { StageConfig } from './stage_config.js';

/** Budget alerts as a percentage of the monthly budget (tech design 11). */
export const BUDGET_THRESHOLDS = [50, 80, 100] as const;

/** The app 5xx alarm fires when over 1% of requests fail, for 3 periods of 5 minutes running. */
export const APP_5XX_PERCENT_THRESHOLD = 1;

/** Cost allocation tag that splits the budget by environment; it must be activated in Billing once. */
export const ENVIRONMENT_TAG = 'environment';

export interface MonitoringStackProps extends StackProps {
  readonly config: StageConfig;
  readonly appFunction: IFunction;
  /** The `Jobs` stack's shared dead-letter queue. */
  readonly deadLetterQueue: IQueue;
}

/**
 * Alert topic, the app 5xx, dead-letter queue and platform spend alarms, and the AWS budget (tech design 11).
 * The dashboard and the other job alarms come later.
 */
export class MonitoringStack extends Stack {
  readonly alertTopic: Topic;
  readonly app5xxAlarm: Alarm;
  readonly deadLetterAlarm: Alarm;
  /** The month's provider spend at 80% and at 100% of the platform cap. */
  readonly spendAlarms: Alarm[];

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

    // The worker publishes the month's spend so far after every job with a provider cost. Between jobs there
    // is no data, which keeps the alarm in its last state rather than flapping back to OK.
    const capCents = config.spendCapUsd * 100;
    const monthlySpend = new Metric({
      namespace: metricsNamespace(config.envName),
      metricName: MONTHLY_SPEND_METRIC,
      statistic: 'Maximum',
      period: Duration.minutes(5),
    });
    this.spendAlarms = SPEND_ALARM_PERCENTS.map((percent) => {
      const alarm = new Alarm(this, `Spend${percent}Alarm`, {
        alarmName: `pictora-${config.envName}-spend-${percent}`,
        alarmDescription:
          `Provider spend this month reached ${percent}% of the $${config.spendCapUsd} platform cap` +
          (percent >= 100 ? '; premium qualities are paused until next month' : ''),
        metric: monthlySpend,
        threshold: (capCents * percent) / 100,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.IGNORE,
      });
      alarm.addAlarmAction(new SnsAction(this.alertTopic));
      return alarm;
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
        // The same total as the platform cap, so AWS spend (Bedrock included) alerts at the same levels as
        // the OpenAI and Google billing alerts (PRD, Global safeguards).
        budgetLimit: { amount: config.spendCapUsd, unit: 'USD' },
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
