/* eslint-disable no-console */
import {
	AwsRegion,
	deployFunction,
	deploySite,
	getOrCreateBucket,
} from '@remotion/lambda';
import path from 'path';
import {webpackOverride} from './remotion.config';
import {
	DISK_SIZE_IN_MB,
	MEM_SIZE_IN_MB,
	SITE_NAME,
	TIMEOUT_IN_SECONDS,
} from './src/remotion/constants';

// Check for AWS credentials
if (!process.env.REMOTION_AWS_ACCESS_KEY_ID) {
	console.log(
		'The environment variable "REMOTION_AWS_ACCESS_KEY_ID" is not set.',
	);
	console.log('Lambda renders were not set up.');
	console.log('');
	console.log('To set up AWS Lambda rendering:');
	console.log('1. Copy .env.example to .env');
	console.log('2. Set up your AWS credentials');
	console.log('3. Run this command again');
	console.log('');
	console.log(
		'📖 Complete setup guide: https://www.remotion.dev/docs/editor-starter/rendering',
	);
	process.exit(0);
}

if (!process.env.REMOTION_AWS_SECRET_ACCESS_KEY) {
	console.log(
		'The environment variable "REMOTION_AWS_SECRET_ACCESS_KEY" is not set.',
	);
	console.log('Lambda renders were not set up.');
	console.log('');
	console.log('To set up AWS Lambda rendering:');
	console.log('1. Copy .env.example to .env');
	console.log('2. Set up your AWS credentials');
	console.log('3. Run this command again');
	console.log('');
	console.log(
		'📖 Complete setup guide: https://www.remotion.dev/docs/editor-starter/rendering',
	);
	process.exit(0);
}

// Check for AWS region
const awsRegion = process.env.REMOTION_AWS_REGION as AwsRegion;
if (!awsRegion) {
	console.log('The environment variable "REMOTION_AWS_REGION" is not set.');
	console.log(
		'Please set it to your preferred AWS region (e.g., "us-east-1").',
	);
	console.log('');
	console.log(
		'Available regions: us-east-1, us-east-2, us-west-1, us-west-2, eu-central-1, eu-west-1, eu-west-2, ap-south-1, ap-southeast-1, ap-southeast-2, ap-northeast-1',
	);
	console.log('');
	console.log(
		'📖 Complete setup guide: https://www.remotion.dev/docs/editor-starter/rendering',
	);
	process.exit(0);
}

console.log('Starting deployment to AWS Lambda...');
console.log(`Region: ${awsRegion}`);
console.log('');

console.log('Ensuring bucket exists...');
const {bucketName: ensuredBucket} = await getOrCreateBucket({
	region: awsRegion,
});
console.log(`Bucket "${ensuredBucket}" ensured.`);

console.log(`Deploying site "${SITE_NAME}"...`);
await deploySite({
	siteName: SITE_NAME,
	entryPoint: path.join(__dirname, 'src', 'remotion', 'index.ts'),
	bucketName: ensuredBucket,
	region: awsRegion,
	options: {
		webpackOverride,
	},
});
console.log(`Site "${SITE_NAME}" deployed.`);

console.log('Deploying function...');
const {functionName} = await deployFunction({
	createCloudWatchLogGroup: true,
	timeoutInSeconds: TIMEOUT_IN_SECONDS,
	memorySizeInMb: MEM_SIZE_IN_MB,
	region: awsRegion,
	diskSizeInMb: DISK_SIZE_IN_MB,
});
console.log(`Function "${functionName}" deployed.`);
