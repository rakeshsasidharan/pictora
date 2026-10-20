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

  it('alarms as soon as any message is in the dead-letter queue', () => {
    dev.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'pictora-dev-dlq',
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Dimensions: [{ Name: 'QueueName', Value: Match.anyValue() }],
      Statistic: 'Maximum',
      Period: 300,
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('^AlertTopic') }],
      OKActions: [{ Ref: Match.stringLikeRegexp('^AlertTopic') }],
    });
  });

  it('alarms when over 5% of finished jobs fail in 15 minutes', () => {
    const [alarm] = Object.values(
      dev.findResources('AWS::CloudWatch::Alarm', {
        Properties: { AlarmName: 'pictora-dev-failure-rate' },
      }),
    );
    expect(alarm?.Properties).toMatchObject({
      Threshold: 5,
      ComparisonOperator: 'GreaterThanThreshold',
      EvaluationPeriods: 1,
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: expect.stringMatching(/^AlertTopic/) }],
    });
    const metrics = alarm?.Properties.Metrics;
    expect(metrics.find((m: { Expression?: string }) => m.Expression).Expression).toContain(
      '100 * FILL(f, 0)',
    );
    const names = metrics
      .filter((m: { MetricStat?: unknown }) => m.MetricStat)
      .map((m: { MetricStat: { Metric: { MetricName: string }; Period: number } }) => [
        m.MetricStat.Metric.MetricName,
        m.MetricStat.Period,
      ]);
    expect(names).toEqual([
      ['JobsSucceeded', 900],
      ['JobsFailed', 900],
      ['JobsBlocked', 900],
    ]);
    expect(JSON.stringify(metrics)).toContain('Pictora/dev');
  });

  it.each(['openai', 'gemini', 'bedrock'])(
    'alarms when p95 %s latency is over 60 s',
    (provider) => {
      dev.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `pictora-dev-${provider}-p95-latency`,
        Namespace: 'Pictora/dev',
        MetricName: 'ProviderLatencyMs',
        Dimensions: Match.arrayWith([
          { Name: 'provider', Value: provider },
          { Name: 'service', Value: 'pictora' },
        ]),
        ExtendedStatistic: 'p95',
        Period: 900,
        Threshold: 60_000,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    },
  );

  it.each(['openai', 'gemini', 'bedrock', 'purge'])(
    'alarms when a message waits in the %s queue for over 5 minutes',
    (queue) => {
      dev.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `pictora-dev-${queue}-oldest-message`,
        Namespace: 'AWS/SQS',
        MetricName: 'ApproximateAgeOfOldestMessage',
        Statistic: 'Maximum',
        Threshold: 300,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    },
  );

  it('alarms on a model health problem or a failed check', () => {
    const [alarm] = Object.values(
      dev.findResources('AWS::CloudWatch::Alarm', {
        Properties: { AlarmName: 'pictora-dev-model-health' },
      }),
    );
    expect(alarm?.Properties).toMatchObject({
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      AlarmActions: [{ Ref: expect.stringMatching(/^AlertTopic/) }],
    });
    const text = JSON.stringify(alarm?.Properties.Metrics);
    expect(text).toContain('ModelHealthProblems');
    expect(text).toContain('"MetricName":"Errors"');
  });

  it('sends every job alarm and its recovery to the alert topic', () => {
    const alarms = Object.values(dev.findResources('AWS::CloudWatch::Alarm'));
    expect(alarms.length).toBe(11);
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toEqual([
        { Ref: expect.stringMatching(/^AlertTopic/) },
      ]);
    }
  });

  it('builds the dashboard: jobs, error rate, 5xx, latency, queues, dead letters and spend', () => {
    const [dashboard] = Object.values(dev.findResources('AWS::CloudWatch::Dashboard'));
    expect(dashboard?.Properties.DashboardName).toBe('pictora-dev');
    const body = JSON.stringify(dashboard?.Properties.DashboardBody);
    for (const title of [
      'Jobs by status',
      'Job error rate (%)',
      'App 5xx (%)',
      'Provider latency p50 (ms)',
      'Provider latency p95 (ms)',
      'Queue depth',
      'Oldest message age (s)',
      'Dead-letter queue depth',
      'Spend today (cents)',
      'Spend this month (cents)',
    ]) {
      expect(body).toContain(title);
    }
    for (const metric of [
      'JobsCreated',
      'ProviderLatencyMs',
      'ApproximateNumberOfMessagesVisible',
      'ProviderCostCents',
      'MonthlySpendCents',
    ]) {
      expect(body).toContain(metric);
    }
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
