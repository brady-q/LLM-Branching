import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export const config = {
  port: Number(process.env.PORT ?? 8787),
  // Relative paths resolve from the repo root, regardless of the process cwd.
  dbPath: fileURLToPath(new URL(process.env.DB_PATH ?? './data.db', new URL('../../', import.meta.url))),
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  chatModel: process.env.CHAT_MODEL ?? 'deepseek/deepseek-v4-flash',
  /** MOCK_LLM=1: fake streamed replies, no API calls (for local testing). */
  mockLlm: process.env.MOCK_LLM === '1',
  mergeModel: process.env.MERGE_MODEL ?? process.env.CHAT_MODEL ?? 'deepseek/deepseek-v4-flash',
};
