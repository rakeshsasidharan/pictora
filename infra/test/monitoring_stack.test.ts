import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { testStage } from './helpers.js';

const dev = Template.fromStack(testStage('PictoraDev').monitoring);

describe('Monitoring stack', () => {
  it('creates the alert topic without a subscription when no email is given', () => {
    dev.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'pictora-dev-alerts' });
    dev.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  it('subscribes the alert email from context', () => {
    const template = Template.fromStack(
      testStage('PictoraDev', { alertEmail: 'alerts@example.com' }).monitoring,
    );
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'alerts@example.com',
    });
  });

  it('alarms when over 1% of app requests return 5xx', () => {
    dev.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'pictora-dev-app-5xx',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 3,
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: Match.anyValue() }],
      Metrics: Match.arrayWith([
        Match.objectLike({
          MetricStat: Match.objectLike({ Metric: Match.objectLike({ MetricName: 'Url5xxCount' }) }),
        }),
        Match.objectLike({
          MetricStat: Match.objectLike({
            Metric: Match.objectLike({ MetricName: 'UrlRequestCount' }),
          }),
        }),
      ]),
    });
  });

  it('budgets the environment with alerts at 50%, 80% and 100% to the alert topic', () => {
    const [budget] = Object.values(dev.findResources('AWS::Budgets::Budget'));
    expect(budget?.Properties.Budget).toMatchObject({
      BudgetName: 'pictora-dev',
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: 15, Unit: 'USD' },
      CostFilters: { TagKeyValue: ['user:environment$dev'] },
    });
    const notifications = budget?.Properties.NotificationsWithSubscribers;
    expect(
      notifications.map((n: { Notification: { Threshold: number } }) => n.Notification.Threshold),
    ).toEqual([50, 80, 100]);
    for (const notification of notifications) {
      expect(notification.Subscribers).toEqual([
        { SubscriptionType: 'SNS', Address: { Ref: expect.stringMatching(/^AlertTopic/) } },
      ]);
    }
  });

  it('lets AWS Budgets publish to the alert topic', () => {
    dev.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sns:Publish',
            Principal: { Service: 'budgets.amazonaws.com' },
          }),
        ]),
      },
    });
  });
});
