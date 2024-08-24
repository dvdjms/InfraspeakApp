import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';

export class CdkInfraspeakStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  
    // Retrieve the secret
    const secretKeyCredentials = secretsmanager.Secret.fromSecretNameV2(this, 'ApiCredentials', 'InfraspeakApp/Production/ApiCredentials');

    //Function to fetch Jira data and populate DynamoDB
    const matchProducts = new NodejsFunction(this, 'match-products', {
    //const matchProducts = new lambda.Function(this, 'match-products', {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        //code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/match-products')),
        entry: path.join(__dirname, '../lambda/match-products/index.mjs'),
        timeout: cdk.Duration.seconds(200),
    });

    // Create EventBridge rule to trigger Lambda every 15 minutes
    const getProjectsRule = new events.Rule(this, 'CronRule', {
        schedule: events.Schedule.rate(cdk.Duration.minutes(720)),
        enabled: true,
    });
          
    // Add the Lambda function as a target of the EventBridge rule
    getProjectsRule.addTarget(new eventTargets.LambdaFunction(matchProducts, {
        deadLetterQueue: new sqs.Queue(this, 'CronDeadLetterQueue'),
        retryAttempts: 2,
    }));

    // Explicitly grant the Lambda function permission to read the secret
    secretKeyCredentials.grantRead(matchProducts);

    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: matchProducts.functionArn,
      description: 'The ARN of the match-products Lambda function',
    });
  } 
}
