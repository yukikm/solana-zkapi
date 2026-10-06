export const shell = `
<header class="masthead"><a class="brand" href="./">zkAPI <span>on Solana</span></a><span class="badge">DEVNET · REVIEWED PROFILES ONLY</span></header>
<div class="intro"><p class="eyebrow">PRIVATE PAYMENTS. YOUR CONVERSATION.</p><h1>Start a conversation.</h1><p>Use a locally held USDC note to pay for API access. Choose where your prompts go before you connect.</p></div>
<p id="notice" class="notice" role="status" aria-live="polite">Choose a reviewed deployment and connect a wallet to begin.</p>
<div class="layout">
  <aside>
    <section class="card" aria-labelledby="setup-heading"><h2 id="setup-heading">1. Connect your note</h2>
      <label for="profile">Deployment and privacy mode</label><select id="profile"><option value="">Choose a reviewed profile</option></select>
      <p id="profile-state" class="hint"></p><p id="privacy" class="privacy">Select a mode to review who can read your content.</p>
      <label class="check"><input id="privacy-ack" type="checkbox"> I understand this mode's content visibility.</label>
      <div class="row"><button id="scan-wallets" class="secondary">Find wallets</button><button id="connect-wallet" class="secondary" disabled>Connect wallet</button></div>
      <label for="wallet">Wallet</label><select id="wallet"><option value="">Find a Wallet Standard wallet</option></select>
      <label for="account">Account</label><select id="account"><option value="">Connect and choose an account</option></select>
      <label for="storage-name">Storage name</label><input id="storage-name" value="zkapi-browser-chat" maxlength="100" autocomplete="off" spellcheck="false">
      <label for="note-id">Local note ID</label><input id="note-id" value="note-1" maxlength="100" autocomplete="off" spellcheck="false">
      <p class="hint">Reopen the same origin, wallet account, storage name and note ID after a reload. Do not clear site data while funded. Portable backup is not available.</p>
      <p id="storage-status" class="hint">Browser persistence will be checked when you open storage.</p>
      <div class="row"><button id="open-note" disabled>Open saved storage</button><button id="create-note" class="secondary" disabled>Create storage</button></div>
      <button id="close-note" class="secondary full" disabled>Close completed / empty note</button>
    </section>
    <section class="card" aria-labelledby="balance-heading"><div class="row spread"><h2 id="balance-heading">2. Balance &amp; funding</h2><button id="refresh" class="small secondary" disabled>Refresh status</button></div>
      <p class="amount"><span id="balance">—</span><span>USDC</span></p><p class="hint">Last verified balance. Pending usage may change it.</p>
      <dl class="facts"><dt>Note</dt><dd id="wallet-state">Not open</dd><dt>Authorization cap</dt><dd id="cap">—</dd><dt>Last verified charge</dt><dd id="charge">—</dd></dl>
      <p id="expiry" class="warning">Note expiry will appear after deposit preparation.</p>
      <label for="deposit-amount">Deposit amount (USDC)</label><input id="deposit-amount" inputmode="decimal" value="2" autocomplete="off">
      <button id="deposit" class="full" disabled>Prepare deposit</button><p class="hint">The suggested amount covers two authorization caps so a small first charge does not immediately block the next request. Edit it before preparing. Continue below to approve each transaction. SOL fees and rent are separate.</p>
    </section>
  </aside>
  <div class="main-column">
    <section class="card chat" aria-labelledby="chat-heading"><div class="row spread"><h2 id="chat-heading">3. Conversation</h2><button id="clear-chat" class="small secondary">Clear conversation</button></div>
      <div class="chat-settings"><div><label for="model">Configured model</label><select id="model" disabled><option value="">Open a note first</option></select></div><div><label for="max-tokens">Maximum output tokens</label><input id="max-tokens" type="number" min="1" max="32768" value="512"></div></div>
      <label for="api">Configured API</label><select id="api" disabled><option value="">Choose a model first</option></select>
      <label class="check"><input id="stream" type="checkbox" checked> Stream the response (SSE)</label>
      <p class="hint">Conversation history stays in this tab's memory and is lost on reload. Complete turns are sent as context to the selected model. No automatic resend.</p>
      <div id="transcript" class="transcript" role="log" aria-label="Conversation"><p class="empty">Your conversation will appear here.</p></div>
      <form id="chat-form"><label for="message">Message</label><textarea id="message" rows="4" placeholder="Ask a question…" maxlength="200000" disabled></textarea>
      <div class="row spread"><p id="send-state" class="hint">Open and fund a note to send.</p><div class="row"><button id="cancel" type="button" class="secondary" disabled>Cancel</button><button id="send" type="submit" disabled>Send message</button></div></div></form>
      <p class="hint">An answer on screen is not a payment receipt. Check the verified charge and saved session below. Cancelling may still incur usage.</p>
    </section>
    <section class="card" aria-labelledby="recovery-heading"><h2 id="recovery-heading">Saved work &amp; recovery</h2>
      <pre id="pending">No note open.</pre><p id="wallet-result" class="hint"></p>
      <div class="row wrap"><button id="advance" disabled>Continue saved wallet step</button><button id="resume-proof" class="secondary" disabled>Resume saved proof</button><button id="recover" class="secondary" disabled>Recover saved session</button><button id="settle" class="secondary" disabled>Request settlement</button></div>
      <p class="hint">Each wallet step may request one signature or check the saved transaction. Unknown sends stay unresolved until verified. Session recovery may repeat the exact saved authorization; it never repeats inference.</p>
      <button id="clear-unaccepted" class="secondary" disabled>Clear an unaccepted authorization</button><p class="hint">For an uncertain authorization with no observed acceptance or inference, request signed permanent clearance before withdrawing. Expiry or a missing session alone cannot release it. If clearance is unavailable, keep the same saved note and try this action again later.</p>
      <details><summary>Advanced recovery</summary><p class="hint">Use only the action matching the saved state. The SDK verifies whether the action is safe.</p><div class="row wrap"><button id="cancel-unsent" class="secondary" disabled>Cancel never-sent authorization</button><button id="reconcile" class="secondary" disabled>Reconcile absent operations</button><button id="retry-rejected" class="secondary" disabled>Retry finalized rejection</button><button id="recover-setup" class="secondary" disabled>Recover expired buffer setup</button></div></details>
    </section>
    <section class="card" aria-labelledby="withdraw-heading"><h2 id="withdraw-heading">Withdraw your balance</h2>
      <label for="destination">Destination wallet owner</label><input id="destination" spellcheck="false" autocomplete="off" placeholder="Solana wallet address">
      <div class="row wrap"><button id="withdraw" class="secondary" disabled>Prepare mutual withdrawal</button><button id="escape" class="secondary" disabled>Prepare escape withdrawal</button><button id="fallback" class="secondary" disabled>Switch unsigned withdrawal to escape</button><button id="finalize" class="secondary" disabled>Prepare escape finalization</button></div>
      <p class="hint">Mutual withdrawal needs signed operator clearance. Escape uses an on-chain challenge window. The SDK checks the deadline before finalization. Continue the saved wallet steps above to complete either path.</p>
      <div class="row wrap"><button id="emergency-escape" class="secondary" disabled>Prepare emergency escape from pending session</button><button id="reconcile-escape" class="secondary" disabled>Check for a challenged escape</button></div>
      <p class="hint">If an unresolved session cannot settle, explicitly prepare an emergency escape to the destination above. It uses the last verified balance and preserves the original authorization and inference operations. New sends stay blocked and inference is never replayed. The operator may challenge the escape during the on-chain window. If challenged, verify the challenge here, then recover or settle the restored session. Otherwise, finalize only after the SDK verifies the chain deadline.</p>
    </section>
  </div>
</div>
<footer>Devnet application example · No default deployment · No production or provider acceptance implied</footer>`;
