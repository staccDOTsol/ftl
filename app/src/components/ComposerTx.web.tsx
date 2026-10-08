// Signing for the Composer. The connected wallet is the payer for every
// builder; each returned transaction is inspected, checked for a live
// blockhash, signed only after a click, relayed through the Composer's /send
// (bundles go to the Jito block engine the service names) and confirmed.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import bs58 from 'bs58'
import { decodeTransaction, encodeTransaction, solanaRpc } from '@/lib/solana'
import { assertTransactionSignature, inspectTransaction, type WireTransaction } from '@/lib/solana-wire'
import { requestWalletConnect, useWalletSelection, useWalletSession } from '@/lib/wallet-session'
import { builtResultOf, composerRequest, failureOf, resolvedAccountsOf, signatureOf, solscanTx, summarizeSimulation, TX_STALE_MS, type BuiltResult, type BuiltTransaction, type ComposerFailure, type SimulationSummary } from '@/lib/composer'
import { short } from '@/lib/format'
import { useSolanaWallets, walletName, WalletSession, type SolanaSigner } from './SolanaWallet.web'
import { Address, Badge, CopyButton, FailureNotice } from './ComposerUI.web'
import { Icon, useToast } from './MarketUI.web'

// --------------------------------------------------------------- wallet ----

interface ComposerWallet { signer: SolanaSigner | null; address: string | null; name: string | null; connect: () => void }
const WalletContext = createContext<ComposerWallet>({ signer: null, address: null, name: null, connect: () => {} })
export const useComposerWallet = () => useContext(WalletContext)

function SignerBridge({ signer, name, onSigner }: { signer: SolanaSigner; name: string; onSigner: (signer: SolanaSigner | null, name: string | null) => void }) {
  useEffect(() => { onSigner(signer, name) }, [signer, name, onSigner])
  useEffect(() => () => onSigner(null, null), [onSigner])
  return null
}

// Resolves the wallet the person connected through the shell into a signer.
// It never opens a wallet prompt on its own; `connect` asks the shell to.
export function ComposerWalletProvider({ children }: { children: ReactNode }) {
  const wallets = useSolanaWallets()
  const [selected, setSelected] = useWalletSelection()
  const session = useWalletSession()
  const toast = useToast()
  const [live, setLive] = useState<{ key: string; signer: SolanaSigner; name: string } | null>(null)
  const onSigner = useCallback((signer: SolanaSigner | null, name: string | null) => setLive(signer && name && selected ? { key: selected, signer, name } : null), [selected])
  const active = !!selected && !!walletName(selected, wallets)
  const signer = active && live?.key === selected ? live.signer : null
  const address = signer?.address ?? (active ? session.address : null)
  const connect = useCallback(() => {
    if (signer && !signer.address) { void signer.connect().catch(error => toast(error instanceof Error ? error.message : 'Wallet connection failed.', true)); return }
    if (!requestWalletConnect()) toast('Use “Connect wallet” at the top of the page to choose a wallet.', true)
  }, [signer, toast])
  const value = useMemo(() => ({ signer, address, name: live?.name ?? session.name, connect }), [signer, address, live?.name, session.name, connect])
  return <WalletContext.Provider value={value}>
    {active ? <div className="lq-composer-bridge"><WalletSession selected={selected} wallets={wallets} onBack={() => { setSelected(null); wallets.rescan() }} embeddedTitle={null}>
      {(sessionSigner, name) => <SignerBridge signer={sessionSigner} name={name} onSigner={onSigner} />}
    </WalletSession></div> : null}
    {children}
  </WalletContext.Provider>
}

// ----------------------------------------------------------- chain reads ----

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// getFeeForMessage answers null once the message's blockhash is no longer
// valid, so it doubles as an expiry check without another RPC method.
async function blockhashLive(message: Uint8Array): Promise<boolean | null> {
  try { return (await solanaRpc<{ value: number | null }>('getFeeForMessage', [encodeTransaction(message), { commitment: 'confirmed' }])).value !== null }
  catch { return null }
}
type Status = 'pending' | 'confirmed' | 'finalized' | 'failed' | 'expired'
async function signatureStatuses(signatures: string[]) {
  const response = await solanaRpc<{ value: ({ err: unknown; confirmationStatus: string | null } | null)[] }>('getSignatureStatuses', [signatures.slice(0, 8), { searchTransactionHistory: true }])
  return response.value
}
async function confirmSignature(signature: string, message: Uint8Array, alive: () => boolean, onTick?: (status: string) => void): Promise<{ status: Status; err?: string }> {
  let misses = 0
  for (let i = 0; i < 45 && alive(); i++) {
    try {
      const [status] = await signatureStatuses([signature])
      if (status?.err) return { status: 'failed', err: JSON.stringify(status.err) }
      if (status?.confirmationStatus === 'finalized') return { status: 'finalized' }
      if (status?.confirmationStatus === 'confirmed') return { status: 'confirmed' }
      onTick?.(status?.confirmationStatus ?? 'not yet seen')
      if (!status && ++misses >= 4 && await blockhashLive(message) === false) return { status: 'expired' }
    } catch { /* keep polling through transient RPC errors */ }
    await sleep(2000)
  }
  return { status: 'pending' }
}

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer) }, [intervalMs])
  return now
}

function inspect(base64: string): { info: WireTransaction | null; bytes: Uint8Array | null; error: string | null } {
  try { const bytes = decodeTransaction(base64); return { info: inspectTransaction(bytes), bytes, error: null } }
  catch (error) { return { info: null, bytes: null, error: error instanceof Error ? error.message : 'Unreadable transaction' } }
}

// ---------------------------------------------------------- single tx ----

type Phase = 'idle' | 'checking' | 'approve' | 'sending' | 'confirming' | 'confirmed' | 'finalized' | 'failed' | 'expired' | 'pending' | 'error'
interface Flow { phase: Phase; signature: string | null; detail: string | null; failure: ComposerFailure | null; rebuild: boolean }
const IDLE: Flow = { phase: 'idle', signature: null, detail: null, failure: null, rebuild: false }
const PHASE_LABEL: Partial<Record<Phase, string>> = { checking: 'Checking the blockhash…', approve: 'Approve in your wallet…', sending: 'Sending through the Composer…', confirming: 'Confirming on Solana…' }

// Names for programs liquidityxyz already recognizes. Anything else is shown as
// unrecognized with links, so the person can look before approving.
const KNOWN_PROGRAMS: Record<string, string> = {
  '11111111111111111111111111111111': 'System', ComputeBudget111111111111111111111111111111: 'Compute budget',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token', TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated token', MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun', pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4', CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM', whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM', cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM v2',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter v6',
}

/** What a Composer-built transaction calls, said before the wallet is asked. */
function ProgramsCalled({ programs, pasted = false }: { programs: string[]; pasted?: boolean }) {
  const unique = [...new Set(programs)]
  const unknown = unique.filter(program => !KNOWN_PROGRAMS[program])
  return <div className="lq-composer-calls">
    <p>{pasted ? 'You pasted this transaction; it was not built here.' : 'Built by the Composer, a hosted service, for your wallet to sign.'} This transaction calls {unique.length} {unique.length === 1 ? 'program' : 'programs'}; any of them can call others:</p>
    <ul>{unique.map(program => <li key={program}>
      <strong>{KNOWN_PROGRAMS[program] ?? 'Not recognized by liquidityxyz'}</strong> <Address value={program} chars={5} />
      {!KNOWN_PROGRAMS[program] ? <> · <a href={`/programs/${program}`}>Program frontier</a> · <a href={`https://solscan.io/account/${program}`} target="_blank" rel="noreferrer">Solscan</a></> : null}
    </li>)}</ul>
    {unknown.length ? <p className="lq-composer-warn">{unknown.length === 1 ? 'One program here is' : `${unknown.length} programs here are`} not one liquidityxyz recognizes. Instructions built from a learned interface carry opaque argument bytes. Check what you are calling before you approve.</p> : null}
    <p>A clean simulation means it ran against current mainnet state. It does not guarantee the outcome when it lands.</p>
  </div>
}

export function TxCard({ tx, blockhash, builtAt, title, onRebuild, rebuilding }: { tx: BuiltTransaction; blockhash: string | null; builtAt: number | null; title?: string; onRebuild?: () => void; rebuilding?: boolean }) {
  const wallet = useComposerWallet()
  const toast = useToast()
  const now = useNow(1000)
  const [flow, setFlow] = useState<Flow>(IDLE)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const decoded = useMemo(() => inspect(tx.transaction), [tx.transaction])
  const info = decoded.info
  const age = builtAt ? Math.max(0, now - builtAt) : 0
  const busy = ['checking', 'approve', 'sending', 'confirming'].includes(flow.phase)
  const done = ['confirmed', 'finalized'].includes(flow.phase)
  const payerMismatch = !!info && !!wallet.address && info.feePayer !== wallet.address
  const otherSigners = info ? info.signerKeys.filter(key => key !== info.feePayer) : []

  async function signAndSend() {
    if (busy || !info || !decoded.bytes) return
    if (!wallet.address || !wallet.signer?.address) { wallet.connect(); return }
    const signer = wallet.signer, owner = signer.address!
    if (info.feePayer !== owner) { setFlow({ ...IDLE, phase: 'error', detail: `Built for ${short(info.feePayer, 6)}, but the connected wallet is ${short(owner, 6)}. Rebuild it for your wallet.`, rebuild: true }); return }
    if (otherSigners.length) { setFlow({ ...IDLE, phase: 'error', detail: `This transaction also needs signatures from ${otherSigners.map(key => short(key, 5)).join(', ')}. Only the payer’s wallet can sign here.` }); return }
    setFlow({ ...IDLE, phase: 'checking' })
    if (await blockhashLive(info.message) === false) { if (alive.current) setFlow({ ...IDLE, phase: 'expired', detail: 'Its blockhash expired before signing. Rebuild it — an expired transaction cannot be resent.', rebuild: true }); return }
    let signed: Uint8Array
    try {
      if (alive.current) setFlow({ ...IDLE, phase: 'approve' })
      signed = await signer.sign(decoded.bytes)
      assertTransactionSignature(decoded.bytes, signed)
    } catch (error) { if (alive.current) setFlow({ ...IDLE, phase: 'error', detail: error instanceof Error ? error.message : 'The wallet did not sign.' }); return }
    const signatureBytes = inspectTransaction(signed).signatures[0]
    const signature = bs58.encode(signatureBytes)
    if (!alive.current) return
    setFlow({ ...IDLE, phase: 'sending', signature })
    try {
      const response = await composerRequest<unknown>('/send', { transaction: encodeTransaction(signed) })
      const returned = signatureOf(response)
      if (returned && returned !== signature && alive.current) toast('The relay reported a different signature; tracking the one your wallet signed.', true)
    } catch (error) {
      const failure = failureOf(error)
      // A timed-out relay may still have landed it: look before declaring failure.
      const [status] = await signatureStatuses([signature]).catch(() => [null])
      if (!status) { if (alive.current) setFlow({ ...IDLE, phase: 'error', signature, failure, rebuild: failure.rebuild || failure.stale }); return }
    }
    if (!alive.current) return
    setFlow(previous => ({ ...previous, phase: 'confirming', detail: null }))
    const result = await confirmSignature(signature, info.message, () => alive.current, status => { if (alive.current) setFlow(previous => ({ ...previous, detail: status })) })
    if (alive.current) setFlow({ ...IDLE, phase: result.status, signature, detail: result.err ?? null, rebuild: result.status === 'expired' })
  }
  async function recheck() {
    if (!flow.signature || !info) return
    const signature = flow.signature
    setFlow(previous => ({ ...previous, phase: 'confirming' }))
    const result = await confirmSignature(signature, info.message, () => alive.current)
    if (alive.current) setFlow({ ...IDLE, phase: result.status, signature, detail: result.err ?? null, rebuild: result.status === 'expired' })
  }

  const label = !wallet.address ? 'Connect wallet to sign' : payerMismatch ? 'Rebuild for your wallet' : PHASE_LABEL[flow.phase] ?? (done ? 'Sent' : 'Sign & send')
  return <div className={`lq-composer-tx ${done ? 'is-done' : ''}`}>
    <header>
      <div><span className="lq-eyebrow">{title ?? 'Unsigned transaction'}</span>
        {info ? <p>{info.version === 'legacy' ? 'Legacy' : `V${info.version}`} · {tx.bytes ?? decoded.bytes?.length ?? '?'} bytes · fee payer <Address value={info.feePayer} chars={5} /></p> : <p className="lq-composer-warn">{decoded.error}</p>}</div>
      <CopyButton text={tx.transaction} label="Copy unsigned transaction (base64)" done="Unsigned transaction copied" className="lq-button lq-button-sm">base64</CopyButton>
    </header>
    {blockhash && builtAt ? <p className={`lq-composer-age ${age > TX_STALE_MS ? 'is-stale' : ''}`}><Icon name="clock" size={12} />Built {Math.floor(age / 1000)}s ago · blockhash {short(blockhash, 5)}{age > TX_STALE_MS ? ' · likely expired: rebuild before signing' : ''}</p> : null}
    {info ? <ProgramsCalled programs={info.programs} /> : null}
    {otherSigners.length ? <p className="lq-composer-warn">Needs {info!.requiredSignatures} signatures. Extra signers: {otherSigners.map(key => short(key, 5)).join(', ')}. The browser wallet can only provide the payer’s.</p> : null}
    {payerMismatch ? <p className="lq-composer-warn">Built for {short(info!.feePayer, 6)}. Your connected wallet is {short(wallet.address!, 6)}, so this preview cannot be signed by it.</p> : null}
    <div className="lq-composer-tx-actions">
      {payerMismatch || flow.rebuild || age > TX_STALE_MS ? onRebuild ? <button type="button" className={`lq-button ${payerMismatch || flow.rebuild ? 'lq-button-primary' : ''}`} disabled={rebuilding || busy} onClick={onRebuild}><Icon name="refresh" size={14} />{rebuilding ? 'Rebuilding…' : payerMismatch ? 'Rebuild for your wallet' : 'Rebuild'}</button> : null : null}
      {!payerMismatch && !done ? <button type="button" className="lq-button lq-button-primary" disabled={busy || !info || !!otherSigners.length} aria-busy={busy} onClick={() => void signAndSend()}>{busy ? <span className="lq-spinner" /> : <Icon name={wallet.address ? 'check' : 'wallet'} size={14} />}{label}</button> : null}
    </div>
    {!wallet.address && !done ? <p className="lq-composer-hint">Previewing only. Connect the wallet that should pay; nothing is signed until you click and approve it.</p> : null}
    <FlowView flow={flow} onRecheck={() => void recheck()} onRebuild={onRebuild} />
  </div>
}

function FlowView({ flow, onRecheck, onRebuild }: { flow: Flow; onRecheck: () => void; onRebuild?: () => void }) {
  if (flow.phase === 'idle' || flow.phase === 'checking' || flow.phase === 'approve') return null
  const tone = flow.phase === 'confirmed' || flow.phase === 'finalized' ? 'good' : flow.phase === 'failed' || flow.phase === 'error' || flow.phase === 'expired' ? 'bad' : 'warn'
  const text: Record<Phase, string> = { idle: '', checking: '', approve: '', sending: 'Relaying', confirming: 'Confirming', confirmed: 'Confirmed', finalized: 'Finalized', failed: 'Failed on-chain', expired: 'Expired unconfirmed', pending: 'Still pending', error: 'Not sent' }
  return <div className={`lq-composer-flow tone-${tone}`} aria-live="polite">
    <Badge tone={tone}>{text[flow.phase]}{flow.phase === 'confirming' && flow.detail ? ` · ${flow.detail}` : ''}</Badge>
    {flow.signature ? <a href={solscanTx(flow.signature)} target="_blank" rel="noreferrer" className="lq-composer-sig"><code>{short(flow.signature, 10)}</code>Solscan <Icon name="external" size={12} /></a> : null}
    {flow.phase === 'failed' && flow.detail ? <p>Program error: <code>{flow.detail}</code></p> : flow.phase !== 'confirming' && flow.detail ? <p>{flow.detail}</p> : null}
    {flow.failure ? <FailureNotice failure={flow.failure} onRebuild={onRebuild} title="The relay rejected it" /> : null}
    {flow.phase === 'pending' ? <button type="button" className="lq-button lq-button-sm" onClick={onRecheck}><Icon name="refresh" size={13} />Check status</button> : null}
  </div>
}

// -------------------------------------------------------------- bundle ----

interface BundleFlow { phase: 'idle' | 'signing' | 'checking' | 'sending' | 'landing' | 'landed' | 'failed' | 'pending' | 'error'; bundleId: string | null; detail: string | null; statuses: (string | null)[] }
const DEFAULT_JITO = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles'
async function jitoCall<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.error) throw new Error(typeof data.error?.message === 'string' ? data.error.message : `Jito block engine returned HTTP ${response.status}`)
  return data.result as T
}

export function BundleCard({ built, builtAt, onRebuild, rebuilding }: { built: BuiltResult; builtAt: number; onRebuild?: () => void; rebuilding?: boolean }) {
  const wallet = useComposerWallet()
  const now = useNow(1000)
  const txs = built.transactions
  const decoded = useMemo(() => txs.map(tx => inspect(tx.transaction)), [txs])
  const [signed, setSigned] = useState<(Uint8Array | null)[]>(() => txs.map(() => null))
  const [flow, setFlow] = useState<BundleFlow>({ phase: 'idle', bundleId: null, detail: null, statuses: [] })
  const endpoints = built.jito?.endpoints.length ? built.jito.endpoints : [DEFAULT_JITO]
  const [endpoint, setEndpoint] = useState(endpoints[0])
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const age = Math.max(0, now - builtAt)
  const next = signed.findIndex(item => !item)
  const mismatch = decoded.some(item => item.info && wallet.address && item.info.feePayer !== wallet.address)
  const foreign = decoded.flatMap(item => item.info ? item.info.signerKeys.filter(key => key !== item.info!.feePayer) : [])
  const busy = ['signing', 'checking', 'sending', 'landing'].includes(flow.phase)
  const signatures = signed.map(item => item ? bs58.encode(inspectTransaction(item).signatures[0]) : null)

  async function signAt(index: number) {
    const item = decoded[index]
    if (busy || !item.info || !item.bytes) return
    if (!wallet.address || !wallet.signer?.address) { wallet.connect(); return }
    if (item.info.feePayer !== wallet.signer.address) { setFlow({ ...flow, phase: 'error', detail: 'This bundle was built for another payer. Rebuild it for your wallet.' }); return }
    if (index === 0) {
      setFlow({ ...flow, phase: 'checking', detail: null })
      if (await blockhashLive(item.info.message) === false) { if (alive.current) setFlow({ ...flow, phase: 'error', detail: 'The shared blockhash expired. Rebuild the bundle; it cannot be resent.' }); return }
    }
    setFlow({ ...flow, phase: 'signing', detail: null })
    try {
      const result = await wallet.signer.sign(item.bytes)
      assertTransactionSignature(item.bytes, result)
      if (alive.current) { setSigned(previous => previous.map((value, i) => i === index ? result : value)); setFlow(previous => ({ ...previous, phase: 'idle' })) }
    } catch (error) { if (alive.current) setFlow(previous => ({ ...previous, phase: 'error', detail: error instanceof Error ? error.message : 'The wallet did not sign.' })) }
  }
  async function send() {
    if (busy || signed.some(item => !item) || !endpoint) return
    const first = decoded[0].info
    setFlow({ phase: 'checking', bundleId: null, detail: null, statuses: [] })
    if (first && await blockhashLive(first.message) === false) { if (alive.current) setFlow({ phase: 'error', bundleId: null, detail: 'The shared blockhash expired while signing. Rebuild the bundle.', statuses: [] }); return }
    setFlow({ phase: 'sending', bundleId: null, detail: null, statuses: [] })
    let bundleId: string
    try { bundleId = await jitoCall<string>(endpoint, 'sendBundle', [signed.map(item => encodeTransaction(item!)), { encoding: 'base64' }]) }
    catch (error) { if (alive.current) setFlow({ phase: 'error', bundleId: null, detail: error instanceof Error ? error.message : 'The block engine rejected the bundle.', statuses: [] }); return }
    const sigs = signatures.filter((sig): sig is string => !!sig)
    for (let i = 0; i < 30 && alive.current; i++) {
      setFlow(previous => ({ ...previous, phase: 'landing', bundleId }))
      try {
        const statuses = await signatureStatuses(sigs)
        const states = statuses.map(status => status?.err ? 'failed' : status?.confirmationStatus ?? null)
        if (alive.current) setFlow(previous => ({ ...previous, statuses: states }))
        if (states.some(state => state === 'failed')) { if (alive.current) setFlow(previous => ({ ...previous, phase: 'failed' })); return }
        if (states.every(state => state === 'confirmed' || state === 'finalized')) { if (alive.current) setFlow(previous => ({ ...previous, phase: 'landed' })); return }
        if (i > 4 && first && await blockhashLive(first.message) === false) { if (alive.current) setFlow(previous => ({ ...previous, phase: 'failed', detail: 'The bundle did not land before its blockhash expired. Landing is not guaranteed; rebuild to try again.' })); return }
      } catch { /* transient */ }
      await sleep(3000)
    }
    if (alive.current) setFlow(previous => ({ ...previous, phase: 'pending' }))
  }

  return <div className="lq-composer-tx">
    <header><div><span className="lq-eyebrow">Jito bundle · {txs.length} transactions</span><p>{built.submit ?? 'Sign every entry in order, then send them together as one bundle.'}</p></div></header>
    {built.blockhash ? <p className={`lq-composer-age ${age > TX_STALE_MS ? 'is-stale' : ''}`}><Icon name="clock" size={12} />Built {Math.floor(age / 1000)}s ago · shared blockhash {short(built.blockhash, 5)}</p> : null}
    {built.jito?.rules.length ? <ul className="lq-composer-rules">{built.jito.rules.map((rule, i) => <li key={i}>{rule}</li>)}</ul> : null}
    {decoded.some(item => item.info) ? <ProgramsCalled programs={decoded.flatMap(item => item.info?.programs ?? [])} /> : null}
    {foreign.length ? <p className="lq-composer-warn">Some entries need signatures from keys other than the payer ({foreign.map(key => short(key, 5)).join(', ')}). The browser wallet cannot provide those.</p> : null}
    {mismatch ? <p className="lq-composer-warn">This bundle was built for another payer. Rebuild it for your connected wallet.</p> : null}
    <ol className="lq-composer-bundle">{txs.map((tx, i) => <li key={i}>
      <span><strong>Transaction {i + 1}</strong><small>{decoded[i].info ? `V${decoded[i].info!.version} · ${tx.bytes ?? decoded[i].bytes?.length} bytes${tx.steps?.length ? ` · steps ${tx.steps.map(step => step + 1).join(', ')}` : ''}` : decoded[i].error}</small></span>
      {signatures[i] ? <a href={solscanTx(signatures[i]!)} target="_blank" rel="noreferrer"><Badge tone={flow.statuses[i] === 'failed' ? 'bad' : flow.statuses[i] ? 'good' : 'warn'}>{flow.statuses[i] ?? 'Signed'}</Badge></a>
        : <button type="button" className="lq-button lq-button-sm" disabled={busy || i !== next || mismatch || !!foreign.length} onClick={() => void signAt(i)}>{!wallet.address ? 'Connect to sign' : `Sign ${i + 1} of ${txs.length}`}</button>}
    </li>)}</ol>
    <div className="lq-composer-tx-actions">
      {endpoints.length > 1 ? <label className="lq-composer-inline">Block engine<select value={endpoint} onChange={event => setEndpoint(event.target.value)} aria-label="Jito block engine region">{endpoints.map(url => <option key={url} value={url}>{new URL(url).hostname.split('.')[0] === 'mainnet' ? 'mainnet (auto)' : new URL(url).hostname.split('.')[0]}</option>)}</select></label> : null}
      {onRebuild ? <button type="button" className="lq-button" disabled={rebuilding || busy} onClick={onRebuild}><Icon name="refresh" size={14} />{rebuilding ? 'Rebuilding…' : 'Rebuild'}</button> : null}
      <button type="button" className="lq-button lq-button-primary" disabled={busy || next !== -1 || !endpoint || flow.phase === 'landed'} aria-busy={busy} onClick={() => void send()}>{busy ? <span className="lq-spinner" /> : <Icon name="arrow" size={14} />}{flow.phase === 'sending' ? 'Sending bundle…' : flow.phase === 'landing' ? 'Waiting for it to land…' : 'Send bundle'}</button>
    </div>
    {flow.bundleId ? <p className="lq-composer-hint">Bundle id <code>{short(flow.bundleId, 10)}</code> <CopyButton text={flow.bundleId} label="Copy bundle id" className="lq-composer-mini" /></p> : null}
    {flow.phase === 'landed' ? <Badge tone="good">Bundle landed</Badge> : flow.phase === 'failed' ? <Badge tone="bad">Bundle did not land</Badge> : flow.phase === 'pending' ? <Badge tone="warn">Still pending · landing is not guaranteed</Badge> : null}
    {flow.detail ? <p className={flow.phase === 'error' || flow.phase === 'failed' ? 'lq-composer-warn' : 'lq-composer-hint'}>{flow.detail}</p> : null}
  </div>
}

// ------------------------------------------------------- pasted (Send) ----

// A pasted transaction: unsigned ones go through the normal sign-and-send card;
// signed ones are verified locally and relayed exactly as pasted.
export function PastedTxCard({ base64 }: { base64: string }) {
  const decoded = useMemo(() => inspect(base64), [base64])
  const info = decoded.info
  const [flow, setFlow] = useState<Flow>(IDLE)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  if (!info || !decoded.bytes) return <p className="lq-composer-warn">{decoded.error ?? 'Unreadable transaction.'}</p>
  const signedCount = info.signatures.filter(sig => sig.some(byte => byte !== 0)).length
  if (!signedCount) return <TxCard tx={{ transaction: base64, signers: info.signerKeys, bytes: decoded.bytes.length, steps: null }} blockhash={null} builtAt={null} title="Pasted unsigned transaction" />
  let verified = true
  try { assertTransactionSignature(decoded.bytes, decoded.bytes) } catch { verified = false }
  const signature = bs58.encode(info.signatures[0])
  const busy = flow.phase === 'sending' || flow.phase === 'confirming'
  async function send() {
    if (busy || !info) return
    setFlow({ ...IDLE, phase: 'sending', signature })
    try { await composerRequest<unknown>('/send', { transaction: base64 }) } catch (error) {
      const failure = failureOf(error)
      const [status] = await signatureStatuses([signature]).catch(() => [null])
      if (!status) { if (alive.current) setFlow({ ...IDLE, phase: 'error', signature, failure, rebuild: failure.rebuild }); return }
    }
    if (!alive.current) return
    setFlow(previous => ({ ...previous, phase: 'confirming' }))
    const result = await confirmSignature(signature, info.message, () => alive.current, status => { if (alive.current) setFlow(previous => ({ ...previous, detail: status })) })
    if (alive.current) setFlow({ ...IDLE, phase: result.status, signature, detail: result.err ?? null })
  }
  return <div className="lq-composer-tx">
    <header><div><span className="lq-eyebrow">Signed transaction</span><p>{info.version === 'legacy' ? 'Legacy' : `V${info.version}`} · {decoded.bytes.length} bytes · fee payer <Address value={info.feePayer} chars={5} /> · {signedCount}/{info.requiredSignatures} signatures</p></div></header>
    <ProgramsCalled programs={info.programs} pasted />
    {!verified ? <p className="lq-composer-warn">At least one signature does not verify against this message. The network will reject it.</p> : signedCount < info.requiredSignatures ? <p className="lq-composer-warn">Missing {info.requiredSignatures - signedCount} required signatures.</p> : null}
    <div className="lq-composer-tx-actions"><button type="button" className="lq-button lq-button-primary" disabled={busy || !verified || flow.phase === 'confirmed' || flow.phase === 'finalized'} onClick={() => void send()}>{busy ? <span className="lq-spinner" /> : <Icon name="arrow" size={14} />}{flow.phase === 'sending' ? 'Relaying…' : flow.phase === 'confirming' ? 'Confirming…' : 'Send'}</button></div>
    <FlowView flow={flow} onRecheck={() => void send()} />
  </div>
}

// -------------------------------------------------------------- shared ----

export function SimulationView({ simulation, title = 'Simulation against mainnet' }: { simulation: unknown; title?: string }) {
  const summary = useMemo(() => summarizeSimulation(simulation), [simulation])
  if (!summary) return null
  return <SimulationSummaryView summary={summary} title={title} />
}
export function SimulationSummaryView({ summary, title }: { summary: SimulationSummary; title: string }) {
  return <section className={`lq-composer-sim ${summary.ok ? 'is-ok' : 'is-failed'}`} aria-label={title}>
    <header><span className="lq-eyebrow">{title}</span><Badge tone={summary.ok ? 'good' : 'bad'}>{summary.ok ? 'Simulates clean' : 'Simulation failed'}</Badge></header>
    {!summary.ok ? <div className="lq-composer-sim-error">
      {summary.errorName ? <strong>{summary.errorName}{summary.errorCode ? <small> · {summary.errorCode}</small> : null}</strong> : summary.errorCode ? <strong>{summary.errorCode}</strong> : null}
      {summary.errorMessage ? <p>{summary.errorMessage}</p> : null}
      <dl>
        {summary.instructionIndex !== null ? <div><dt>Instruction</dt><dd>#{summary.instructionIndex}</dd></div> : null}
        {summary.failingProgram ? <div><dt>Program</dt><dd><Address value={summary.failingProgram} chars={5} /></dd></div> : null}
        {summary.thrownIn ? <div><dt>Thrown in</dt><dd><code>{summary.thrownIn}</code></dd></div> : null}
      </dl>
      {summary.note ? <p className="lq-composer-note">{summary.note}</p> : null}
    </div> : null}
    <p className="lq-composer-meta">{summary.unitsConsumed !== null ? `${summary.unitsConsumed.toLocaleString()} compute units` : ''}{summary.fee !== null ? ` · fee ${summary.fee.toLocaleString()} lamports` : ''}</p>
    {summary.bundle ? <ol className="lq-composer-bundle-sim">{summary.bundle.map(item => <li key={item.index}><Badge tone={item.ok ? 'good' : 'bad'}>Tx {item.index + 1}</Badge>{item.err ? <code>{item.err}</code> : <span>{item.unitsConsumed !== null ? `${item.unitsConsumed.toLocaleString()} CU` : 'ok'}</span>}</li>)}</ol> : null}
    {summary.logs.length ? <details className="lq-composer-logs"><summary><Icon name="chevron" size={12} />Program logs ({summary.logs.length})</summary><pre tabIndex={0}>{summary.logs.join('\n')}</pre></details> : null}
  </section>
}

export function AccountsView({ response }: { response: unknown }) {
  const groups = useMemo(() => resolvedAccountsOf(response), [response])
  if (!groups.length || groups.every(group => !group.accounts.length)) return null
  return <details className="lq-composer-accounts" open={groups.length === 1 && groups[0].accounts.length <= 24}>
    <summary><Icon name="chevron" size={12} />Resolved accounts</summary>
    {groups.map((group, g) => <div key={g}>
      {group.step ? <h4>{group.step}</h4> : null}
      <table><thead><tr><th scope="col">Account</th><th scope="col">Address</th><th scope="col">Flags</th><th scope="col">Source</th></tr></thead>
        <tbody>{group.accounts.map((account, i) => <tr key={`${account.name}:${i}`}>
          <td data-label="Account"><code>{account.name || `#${i}`}</code></td>
          <td data-label="Address">{account.pubkey ? <Address value={account.pubkey} chars={5} /> : '—'}</td>
          <td data-label="Flags"><span className="lq-composer-flags">{account.signer ? <b title="Signer">S</b> : null}{account.writable ? <b title="Writable">W</b> : null}{account.optional ? <i title="Optional">opt</i> : null}</span></td>
          <td data-label="Source"><small>{account.source ?? ''}</small></td>
        </tr>)}</tbody></table>
    </div>)}
  </details>
}

// The whole result of a builder: simulation, accounts and the signing card(s).
export function BuiltView({ response, builtAt, onRebuild, rebuilding, title }: { response: unknown; builtAt: number; onRebuild?: () => void; rebuilding?: boolean; title?: string }) {
  const built = useMemo(() => builtResultOf(response), [response])
  const record = response && typeof response === 'object' ? response as Record<string, unknown> : {}
  return <div className="lq-composer-built">
    {record.simulation ? <SimulationView simulation={record.simulation} /> : built.mode !== 'none' ? <p className="lq-composer-hint">Not simulated. Turn on “Simulate against mainnet” to check it before signing.</p> : null}
    <AccountsView response={response} />
    {built.mode === 'single' ? <TxCard tx={built.transactions[0]} blockhash={built.blockhash} builtAt={builtAt} title={title} onRebuild={onRebuild} rebuilding={rebuilding} /> : null}
    {built.mode === 'bundle' ? <BundleCard key={built.blockhash ?? builtAt} built={built} builtAt={builtAt} onRebuild={onRebuild} rebuilding={rebuilding} /> : null}
  </div>
}
