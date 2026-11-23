// "Explain this": send one finding and only its evidence events to an LLM (W&B Inference,
// OpenAI-compatible), then check every claim in the answer against the evidence.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later

import type { Finding } from '../detect/types.js';
import { fmtDur, fmtTime } from '../detect/util.js';
import { eventLine } from '../model/format.js';
import type { Model } from '../model/model.js';
import { buildClaimContext, checkClaims, summarizeClaims, type Claim } from './claims.js';
import { postJson } from './http.js';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModel: string;
  timeoutMs: number;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  if (!env.OPENAI_API_KEY) return null;
  return {
    baseUrl: (env.OPENAI_BASE_URL || 'https://api.inference.wandb.ai/v1').replace(/\/+$/, ''),
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL || 'Qwen/Qwen3.8-27B',
    fallbackModel: env.OPENAI_FALLBACK_MODEL || 'zai-org/GLM-5.3-Flash',
    timeoutMs: Number(env.LATENCYLENS_LLM_TIMEOUT_MS || 60000),
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const SYSTEM = `You are a senior QNX OS 8.0 real-time engineer. You explain one finding from a kernel event trace captured with tracelogger.
Use only the facts and events given. Name threads exactly as they are written. Quote only numbers that appear in the facts; never invent a thread, a priority or a duration. Say which mutex protocol was in effect only as far as the facts show it.
QNX background: SCHED_FIFO priorities (a higher number wins), thread states (RUNNING, READY, SEND, REPLY and RECEIVE blocked, MUTEX, NANOSLEEP, INTR), mutex protocols (PTHREAD_PRIO_INHERIT, the QNX default, and PTHREAD_PRIO_PROTECT), message passing (MsgSend, MsgReceive, MsgReply, where a server runs at its client's priority), interrupt service threads (InterruptAttachThread; QNX 8.0 has no ISRs).
Answer for an engineer, in plain words, in exactly this format:
CAUSE: two to four sentences on what happened and why.
FIX: one to three sentences with a concrete change to the code or the configuration.`;

function factLine(f: Finding['facts'][number]): string {
  switch (f.kind) {
    case 'duration':
      return `- ${f.label}: ${fmtDur(Number(f.value))}`;
    case 'time':
      return `- ${f.label}: ${fmtTime(Number(f.value))} into the trace`;
    case 'percent':
      return `- ${f.label}: ${Number(f.value).toFixed(1)}%`;
    case 'cpu':
      return `- ${f.label}: CPU ${f.value}`;
    default:
      return `- ${f.label}: ${f.value}`;
  }
}

export function buildPrompt(m: Model, f: Finding, maxEvents = 120): ChatMessage[] {
  const t0 = f.window[0];
  const ev = f.evidence.length > maxEvents ? f.evidence.filter((_, k) => k % Math.ceil(f.evidence.length / maxEvents) === 0) : f.evidence;
  const threads = f.threads.map((th) => `${m.threads[th].label} (priority ${m.threads[th].basePrio})`).join(', ');
  const user = [
    `Finding: ${f.title}`,
    `Kind: ${f.kind}`,
    `Threads involved: ${threads}`,
    'Facts measured from the trace:',
    ...f.facts.map(factLine),
    `Evidence events (milliseconds after ${fmtTime(t0)}, CPU, class, event):`,
    ...ev.map((i) => eventLine(m, i, t0)),
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

export interface CompletionResult {
  text: string;
  model: string;
  ms: number;
  usedFallback: boolean;
}

async function chat(cfg: LlmConfig, model: string, messages: ChatMessage[], thinkingOff: boolean): Promise<string> {
  const body: Record<string, unknown> = { model, messages, temperature: 0.2, max_tokens: 700 };
  // Qwen3 models think by default; the explanation needs no hidden reasoning and should be quick.
  if (thinkingOff) body.chat_template_kwargs = { enable_thinking: false };
  const res = await postJson(`${cfg.baseUrl}/chat/completions`, body, { authorization: `Bearer ${cfg.apiKey}` }, cfg.timeoutMs);
  if (res.status < 200 || res.status >= 300) throw new Error(`${model}: HTTP ${res.status} ${res.body.slice(0, 200)}`);
  const data = JSON.parse(res.body) as { choices?: { message?: { content?: string | null } }[] };
  const text = (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error(`${model}: empty answer`);
  return text;
}

export async function complete(cfg: LlmConfig, messages: ChatMessage[]): Promise<CompletionResult> {
  const t0 = performance.now();
  try {
    const text = await chat(cfg, cfg.model, messages, /qwen3/i.test(cfg.model));
    return { text, model: cfg.model, ms: performance.now() - t0, usedFallback: false };
  } catch (err) {
    if (!cfg.fallbackModel || cfg.fallbackModel === cfg.model) throw err;
    const text = await chat(cfg, cfg.fallbackModel, messages, /qwen3/i.test(cfg.fallbackModel));
    return { text, model: cfg.fallbackModel, ms: performance.now() - t0, usedFallback: true };
  }
}

export interface Explanation {
  findingId: string;
  cause: string;
  fix: string;
  text: string;
  model: string;
  ms: number;
  usedFallback: boolean;
  claims: Claim[];
  claimSummary: { ok: number; mismatch: number; unknown: number; proposal: number };
  promptChars: number;
}

export function parseAnswer(text: string): { cause: string; fix: string } {
  const clean = text.replace(/\*\*/g, '');
  const c = /CAUSE\s*:\s*([\s\S]*?)(?=\n\s*FIX\s*:|$)/i.exec(clean);
  const f = /FIX\s*:\s*([\s\S]*)$/i.exec(clean);
  return { cause: (c?.[1] ?? clean).trim(), fix: (f?.[1] ?? '').trim() };
}

/** Explain a finding; `answer` lets tests and the demo replay a recorded model answer. */
export async function explainFinding(m: Model, f: Finding, cfg: LlmConfig | null, answer?: CompletionResult): Promise<Explanation> {
  const messages = buildPrompt(m, f);
  let res = answer;
  if (!res) {
    if (!cfg) throw new Error('no LLM configured: set OPENAI_API_KEY (and optionally OPENAI_BASE_URL, OPENAI_MODEL) in .env');
    res = await complete(cfg, messages);
  }
  const { cause, fix } = parseAnswer(res.text);
  const body = `${cause}\n${fix}`;
  const claims = checkClaims(body, buildClaimContext(m, f), cause.length + 1);
  return {
    findingId: f.id,
    cause,
    fix,
    text: body,
    model: res.model,
    ms: res.ms,
    usedFallback: res.usedFallback,
    claims,
    claimSummary: summarizeClaims(claims),
    promptChars: messages.reduce((s, x) => s + x.content.length, 0),
  };
}
