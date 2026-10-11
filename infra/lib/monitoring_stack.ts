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
import type { Construct } from 'constructs';
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
}

/** Alert topic, app alarms and the AWS budget (tech design 11). The dashboard and job alarms come later. */
export class MonitoringStack extends Stack {
  readonly alertTopic: Topic;
  readonly app5xxAlarm: Alarm;

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
