// Simple liquidity transport: plan (pool choice, split, quotes) and per-step
// build against the server's zap routes, over the same request() helper as
// the swap and liquidity calls.
import { request } from './solana'
import type { ZapBuild, ZapPlan, ZapPlanRequest } from './solana-zap-model'
import type { TransactionVersion } from './solana-wire'
export * from './solana-zap-model'

const endpoint = '/api/zap/solana'
export const zapPlan = (body: ZapPlanRequest) => request<ZapPlan>(`${endpoint}/plan`, body)
export const zapBuild = (body: { planId: string; owner: string; step: number; transactionVersion: TransactionVersion; confirmed: string[] }) => request<ZapBuild>(`${endpoint}/build`, body)
