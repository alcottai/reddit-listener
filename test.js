process.env.SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || 'YOUR_WEBHOOK_URL_HERE';
process.env.HOURS_BACK = '168';

const { handler } = require('./index');

async function test() {
  console.log('Starting Reddit listener test...\n');
  try {
    const result = await handler({});
    console.log('\nResult:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error:', error);
  }
}

test();