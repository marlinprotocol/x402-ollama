import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';
try {
  process.loadEnvFile?.();
} catch {
  // .env is optional; environment variables may already be set.
}

const CHAT_API_URL = process.env.CHAT_API_URL ?? 'http://localhost:3000/api/chat-v2';
const MODEL = process.env.CHAT_MODEL ?? 'qwen3:0.6b';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

async function main() {
  if (!PRIVATE_KEY) {
    throw new Error('Missing PRIVATE_KEY in environment.');
  }

  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log('Using account:', account.address);

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
      {
        network: 'eip155:84532',
        client: new ExactEvmScheme(account),
      },
    ],
  });

  const response = await fetchWithPayment(CHAT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Hello!' }],
      stream: false,
    }),
  });

  console.log('Status:', response.status, response.statusText);
  console.log('Headers:', Object.fromEntries(response.headers.entries()));

  const text = await response.text();
  console.log('Body:', text);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
