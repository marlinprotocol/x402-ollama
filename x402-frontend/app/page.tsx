'use client';

import { FormEvent, useMemo, useState } from 'react';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { useWalletClient, usePublicClient } from 'wagmi';
import { ConnectWallet } from '@/components/ConnectWallet';
import { keccak256, recoverPublicKey, Hex } from 'viem';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type ChatRole = 'user' | 'assistant';

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  signature?: string;
  pubkey?: string;
};

const DEFAULT_MODEL = 'qwen3:0.6b';
const CHAT_API_URL = process.env.NEXT_PUBLIC_CHAT_API_URL ?? 'http://127.0.0.1:3000/api/chat-v2';

/** Build the signing message exactly as the Rust verifier does (oyster-signature-v2). */
function buildSigningMessage(
  method: string,
  pathAndQuery: string,
  requestBody: Uint8Array,
  responseBody: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder();
  const prefix = enc.encode('oyster-signature-v2\0');
  const methodBytes = enc.encode(method);
  const pathBytes = enc.encode(pathAndQuery);

  const buf = new ArrayBuffer(
    prefix.length +
    4 + methodBytes.length +
    4 + pathBytes.length +
    8 + requestBody.length +
    8 + responseBody.length,
  );
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  let offset = 0;

  out.set(prefix, offset); offset += prefix.length;

  view.setUint32(offset, methodBytes.length, false); offset += 4;
  out.set(methodBytes, offset); offset += methodBytes.length;

  view.setUint32(offset, pathBytes.length, false); offset += 4;
  out.set(pathBytes, offset); offset += pathBytes.length;

  // request body length as u64 big-endian
  view.setUint32(offset, 0, false); offset += 4;
  view.setUint32(offset, requestBody.length, false); offset += 4;
  out.set(requestBody, offset); offset += requestBody.length;

  // response body length as u64 big-endian
  view.setUint32(offset, 0, false); offset += 4;
  view.setUint32(offset, responseBody.length, false); offset += 4;
  out.set(responseBody, offset);

  return out;
}

/** Recover the secp256k1 public key from a 65-byte signature + the signing message. */
async function recoverPubKeyFromSignature(
  signatureHex: string,
  method: string,
  pathAndQuery: string,
  requestBody: Uint8Array,
  responseBody: Uint8Array,
): Promise<string | null> {
  try {
    const sigBytes = Uint8Array.from(
      signatureHex.replace(/^0x/, '').match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    );
    if (sigBytes.length !== 65) return null;

    const message = buildSigningMessage(method, pathAndQuery, requestBody, responseBody);
    const hash = keccak256(message);

    // Extract r, s, v from the 65-byte signature
    const r = ('0x' + Array.from(sigBytes.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
    const s = ('0x' + Array.from(sigBytes.slice(32, 64)).map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
    const yParity = sigBytes[64] >= 27 ? sigBytes[64] - 27 : sigBytes[64];

    const pubkey = await recoverPublicKey({ hash, signature: { r, s, yParity } });
    // Strip the 0x04 uncompressed prefix, return only x+y (matching the Rust output)
    return pubkey.slice(4);
  } catch (e) {
    console.error('Failed to recover public key:', e);
    return null;
  }
}

function parseAssistantText(raw: string): string {
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);

    if (typeof parsed === 'string') return parsed;
    if (typeof parsed.response === 'string') return parsed.response;
    if (typeof parsed.output === 'string') return parsed.output;
    if (typeof parsed.message === 'string') return parsed.message;
    if (parsed.message && typeof parsed.message.content === 'string') return parsed.message.content;

    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

/** Split content into thinking and visible parts. */
function splitThinkContent(content: string): { think: string | null; reply: string } {
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  if (!thinkMatch) return { think: null, reply: content };
  const think = thinkMatch[1].trim();
  const reply = content.replace(/<think>[\s\S]*?<\/think>/, '').trim();
  return { think: think || null, reply };
}

export default function Home() {
  const [prompt, setPrompt] = useState('What are Trusted Execution Environments?');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const endpoint = useMemo(() => CHAT_API_URL, []);

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || loading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmedPrompt,
    };

    setMessages((prev) => [...prev, userMessage]);
    setPrompt('');
    setLoading(true);
    setError(null);

    try {
      const requestMessages = [...messages, userMessage].map((message) => ({
        role: message.role,
        content: message.content,
      }));

      const fetchFn = (walletClient && publicClient)
        ? wrapFetchWithPaymentFromConfig(fetch, {
          schemes: [
            {
              network: 'eip155:84532',
              client: new ExactEvmScheme({
                address: walletClient.account.address,
                signTypedData: (args: Parameters<typeof walletClient.signTypedData>[0]) =>
                  walletClient.signTypedData(args),
                readContract: (args: any) => publicClient.readContract(args as any),
              }),
            },
          ],
        })
        : fetch;

      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: requestMessages,
          stream: false,
        }),
      });

      const responseText = await response.text();
      const signature = response.headers.get('x-signature') ?? response.headers.get('X-Signature');

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText} - ${responseText}`);
      }

      // Recover the public key from the signature (mirrors the Rust verifier)
      let pubkey: string | undefined;
      if (signature) {
        const parsedUrl = new URL(endpoint);
        const pathAndQuery = parsedUrl.pathname + (parsedUrl.search || '');
        const reqBodyBytes = new TextEncoder().encode(JSON.stringify({
          model,
          messages: requestMessages,
          stream: false,
        }));
        const resBodyBytes = new TextEncoder().encode(responseText);
        const recovered = await recoverPubKeyFromSignature(
          signature,
          'POST',
          pathAndQuery,
          reqBodyBytes,
          resBodyBytes,
        );
        if (recovered) pubkey = recovered;
      }

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: parseAssistantText(responseText),
        signature: signature ?? undefined,
        pubkey,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send message.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#1b2f2a_0%,#0a1311_55%,#070d0b_100%)] text-[#edf4f1]">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-8 sm:py-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#2f4a42] bg-[#0f1d1a]/90 px-5 py-4 shadow-[0_12px_40px_rgba(0,0,0,0.32)] backdrop-blur">
          <div>
            <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              Oyster Ollama Chat
              <span className="rounded-full border border-[#2b5a4e] bg-[#15382f] px-3 py-1 text-xs font-medium uppercase tracking-[0.12em] text-[#9dd5c1]">x402</span>
            </h1>
          </div>
          <ConnectWallet />
        </header>

        <section className="rounded-2xl border border-[#2f4a42] bg-[#0f1d1a]/90 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.22)] sm:p-5">
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[#28443d] bg-[#0a1412] px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-[#7fa396]">Model</span>
              <span className="rounded-md border border-[#2b5a4e] bg-[#15382f] px-2.5 py-1 font-mono text-xs text-[#9dd5c1]">{model}</span>
            </div>
            <span className="hidden sm:block h-4 w-px bg-[#2f4a42]"></span>
            <span className="text-xs text-[#7fa396]">{messages.length} message{messages.length === 1 ? '' : 's'}</span>
          </div>

          <div className="mb-4 h-[560px] overflow-y-auto rounded-xl border border-[#28443d] bg-[#0a1412] p-3 sm:p-4">
            {messages.length === 0 && !loading ? (
              <p className="text-sm text-[#7fa396]">No messages yet. Ask your first question below.</p>
            ) : (
              <div className="space-y-4">
                {messages.map((message) => {
                  const { think, reply } = message.role === 'assistant'
                    ? splitThinkContent(message.content)
                    : { think: null, reply: message.content };
                  return (
                    <article
                      key={message.id}
                      className={`rounded-xl border p-3 text-sm shadow-[0_8px_20px_rgba(0,0,0,0.2)] ${message.role === 'user'
                        ? 'border-[#355b50] bg-[#123229]'
                        : 'border-[#415f88] bg-[#18263d]'
                        }`}
                    >
                      <p className="mb-1 text-xs font-medium tracking-[0.1em] text-[#9fbab1]">{message.role === 'assistant' ? 'oyster' : (walletClient?.account?.address ? `${walletClient.account.address.slice(0, 6)}…${walletClient.account.address.slice(-4)}` : 'user')}</p>
                      {think && (
                        <details className="mb-2 rounded-lg border border-[#6b5b8a] bg-[#1e1533]">
                          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-[0.1em] text-[#c4a8e6] hover:text-[#dcc5f5] transition-colors">
                            💭 Thinking
                          </summary>
                          <div className="border-t border-[#6b5b8a] px-3 py-2 text-xs text-[#b8a0d6] whitespace-pre-wrap break-words leading-relaxed">
                            {think}
                          </div>
                        </details>
                      )}
                      {message.role === 'assistant' ? (
                        <div className="prose-invert prose-sm max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre]:text-xs [&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-xs [&_code]:text-[#a8e6cf] [&_a]:text-[#7bd1b2] [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-[#7bd1b2] [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-[#91b5a9] [&_table]:w-full [&_th]:border [&_th]:border-[#2f4a42] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-[#2f4a42] [&_td]:px-2 [&_td]:py-1 [&_hr]:border-[#2f4a42] [&_strong]:text-[#c4f0d6]">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{reply}</ReactMarkdown>
                        </div>
                      ) : (
                        <p className="whitespace-pre-wrap break-words">{reply}</p>
                      )}
                      {message.signature && (
                        <div className="mt-2 rounded-lg border border-[#56658b] bg-[#111c30] p-2">
                          <p className="text-xs uppercase tracking-[0.1em] text-[#9fb5ae]">Signature</p>
                          <p className="break-all font-mono text-xs text-[#d6dff8]">{message.signature}</p>
                        </div>
                      )}
                      {message.pubkey && (
                        <div className="mt-2 rounded-lg border border-[#4a6b56] bg-[#0f2318] p-2">
                          <p className="text-xs uppercase tracking-[0.1em] text-[#9fb5ae]">Recovered Public Key</p>
                          <p className="break-all font-mono text-xs text-[#c4f0d6]">{message.pubkey}</p>
                        </div>
                      )}
                    </article>
                  );
                })}
                {loading && (
                  <div className="rounded-xl border border-[#415f88] bg-[#18263d] p-4 text-sm shadow-[0_8px_20px_rgba(0,0,0,0.2)]">
                    <p className="mb-2 text-xs font-medium tracking-[0.1em] text-[#9fbab1]">oyster</p>
                    <div className="flex items-center gap-2">
                      <span className="flex gap-1">
                        <span className="h-2 w-2 rounded-full bg-[#3db48a] animate-bounce [animation-delay:0ms]"></span>
                        <span className="h-2 w-2 rounded-full bg-[#3db48a] animate-bounce [animation-delay:150ms]"></span>
                        <span className="h-2 w-2 rounded-full bg-[#3db48a] animate-bounce [animation-delay:300ms]"></span>
                      </span>
                      <span className="text-xs text-[#7fa396]">Processing payment & generating response…</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="mb-4 rounded-lg border border-[#8a4040] bg-[#311919] p-3 text-sm text-[#f7c7c7]">
              {error}
            </div>
          )}

          <div className="relative group">
            {!walletClient && (
              <div className="pointer-events-none absolute -top-9 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[#2f4a42] bg-[#0f1d1a] px-3 py-1.5 text-xs text-[#98c7b9] opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                Connect wallet to enable x402 chat
              </div>
            )}
            <form onSubmit={sendMessage} className="flex items-stretch gap-3">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={1}
                placeholder={walletClient ? 'Ask something...' : 'Connect wallet to start...'}
                disabled={!walletClient}
                className="flex-1 resize-none rounded-xl border border-[#36554b] bg-[#0d1715] px-3 py-2 text-sm outline-none transition focus:border-[#7bd1b2] focus:ring-2 focus:ring-[#295e4d] disabled:cursor-not-allowed disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={loading || !walletClient}
                className="flex cursor-pointer items-center gap-2 rounded-xl bg-[#3db48a] px-6 text-sm font-semibold text-[#04120d] shadow-[0_4px_16px_rgba(61,180,138,0.25)] transition hover:bg-[#57cda3] hover:shadow-[0_4px_20px_rgba(61,180,138,0.35)] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
              >
                {loading ? 'Sending...' : 'Send'}
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                  <path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.414 4.926A1.5 1.5 0 0 0 5.135 9.25h6.115a.75.75 0 0 1 0 1.5H5.135a1.5 1.5 0 0 0-1.442 1.086l-1.414 4.926a.75.75 0 0 0 .826.95 28.11 28.11 0 0 0 15.95-7.256.75.75 0 0 0 0-1.012A28.11 28.11 0 0 0 3.105 2.288Z" />
                </svg>
              </button>
            </form>
          </div>

          <details className="mt-4 rounded-xl border border-[#28443d] bg-[#0a1412]">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-[#98c7b9] hover:text-[#c4f0d6] transition-colors">
              🔐 Verifying Signatures
            </summary>
            <div className="border-t border-[#28443d] px-4 py-4 text-sm text-[#91b5a9] space-y-3">
              <p>
                Each response from an Oyster CVM enclave includes a cryptographic signature. The <strong className="text-[#c4f0d6]">Recovered Public Key</strong> shown above is extracted from this signature and should match the key derived from the KMS.
              </p>

              <p className="text-xs font-medium text-[#98c7b9]">Get the expected public key using KMS derive:</p>
              <pre className="overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-xs text-[#a8e6cf]">
                {`oyster-cvm kms-derive \\
  --image-id <IMAGE_ID> \\
  --path signing-server \\
  --key-type secp256k1/public`}
              </pre>

              <p className="text-xs font-medium text-[#98c7b9]">If the keys match, this confirms:</p>
              <ol className="list-decimal pl-5 space-y-1 text-xs">
                <li>The response was signed by a valid Oyster enclave</li>
                <li>The enclave is running the expected image (identified by <code className="rounded bg-black/30 px-1 py-0.5 text-[#a8e6cf]">image-id</code>)</li>
                <li>The signature was created using the KMS-derived key for the <code className="rounded bg-black/30 px-1 py-0.5 text-[#a8e6cf]">signing-server</code> path</li>
              </ol>

            </div>
          </details>
        </section>
      </div>
    </main>
  );
}
