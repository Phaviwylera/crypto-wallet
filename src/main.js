import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import './style.css';

const app = document.querySelector('#app');
let phrase = '';
let seedHex = '';
let copied = false;
let searchSeed = '';
let searchPassphrase = '';
let candidatePhrases = '';
let searchResult = '';

function render() {
  const step2 = Boolean(seedHex);
  app.innerHTML = `
    <header class="topbar"><a class="brand" href="#"><span class="brand-icon">◈</span> seed<span>lab</span></a><div class="top-meta"><span class="live-dot"></span> LOCAL DEMO <span class="divider">/</span> NO WALLET CONNECTED</div></header>
    <main>
      <div class="eyebrow"><span>YOUR FIRST WALLET</span><span class="line"></span><span>LESSON 02 / 05</span></div>
      <section class="hero"><div><h1>A wallet begins<br/>with <em>randomness.</em></h1><p class="intro">We’ll build one piece at a time. Your phrase is ready; now derive the BIP-39 seed. Still no private key or address.</p></div><div class="lesson-card"><div class="card-label"><span class="number">01</span> THE BUILD SEQUENCE</div><div class="sequence"><div class="seq-item done"><b>01</b><span>Seed phrase</span><i>DONE</i></div><div class="seq-item ${step2 ? 'active' : ''}"><b>02</b><span>Seed</span>${step2 ? '<i>YOU ARE HERE</i>' : ''}</div><div class="seq-item"><b>03</b><span>Private key</span></div><div class="seq-item"><b>04</b><span>Public key</span></div><div class="seq-item"><b>05</b><span>Ethereum address</span></div></div></div></section>
      <section class="workspace"><div class="panel-title"><div><span class="section-kicker">STEP 01 · ${step2 ? 'COMPLETE' : 'START HERE'}</span><h2>Your recovery phrase</h2></div><span class="badge">BIP-39 · 12 WORDS</span></div><p class="explain">Generated from browser cryptographic randomness and the standard English BIP-39 word list. The phrase stays in this page’s memory only.</p>
      <div class="phrase-box ${phrase ? 'has-phrase' : ''}">${phrase ? `<div class="words">${phrase.split(' ').map((w,i)=>`<div class="word"><span>${String(i+1).padStart(2,'0')}</span>${w}</div>`).join('')}</div>` : `<div class="empty-state"><span class="spark">✳</span><span>Start by generating your 12 words.</span><small>Nothing is generated until you press the button.</small></div>`}</div>
      <div class="actions"><button class="primary" id="generate">${phrase ? '↻ &nbsp; Generate a new phrase' : '✳ &nbsp; Generate seed phrase'} <span>→</span></button>${phrase ? `<button class="secondary" id="copy">${copied ? 'Copied!' : 'Copy phrase'}</button>` : ''}</div>
      ${phrase ? `<div class="step-two"><div class="panel-title"><div><span class="section-kicker">STEP 02</span><h2>Derive the BIP-39 seed</h2></div><span class="badge">512-BIT OUTPUT</span></div><p class="explain">BIP-39 runs the phrase through PBKDF2-HMAC-SHA512 (2,048 iterations). This lesson uses an empty optional passphrase. The result is the binary seed used by later wallet derivation—not a private key.</p><button class="primary" id="derive">${step2 ? '✓ &nbsp; Seed derived' : 'Derive seed'} <span>→</span></button>${step2 ? `<div class="seed-result"><div class="seed-caption"><span>512-BIT SEED · HEX</span><span>128 HEX CHARACTERS</span></div><code>${seedHex.match(/.{1,8}/g).join(' ')}</code><button class="secondary back-button" id="back-to-phrase">← &nbsp; Back to recovery phrase</button><p class="reverse-note">This returns to the phrase held in this page’s memory. PBKDF2 is one-way, so a seed cannot be reversed to recover its phrase.</p></div>` : ''}</div>` : ''}
      <section class="search-lab"><div class="panel-title"><div><span class="section-kicker">EXPERIMENT</span><h2>Search a bounded candidate list</h2></div><span class="badge">LOCAL ONLY</span></div><p class="explain">There is no practical inverse for PBKDF2. This lab only checks phrases you supply, one per line, against a seed. It does not generate or search all possible phrases. Use demo data only.</p><label class="field-label" for="search-seed">BIP-39 seed · 128 hex characters</label><textarea id="search-seed" class="single-line" placeholder="Paste 64 bytes of seed as 128 hexadecimal characters">${searchSeed.replaceAll('&','&amp;').replaceAll('<','&lt;')}</textarea><label class="field-label" for="search-passphrase">Optional BIP-39 passphrase (same one used to create the seed)</label><input id="search-passphrase" type="password" autocomplete="off" placeholder="Leave empty if none was used" value="${searchPassphrase.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')}"/><label class="field-label" for="candidate-phrases">Candidate 12-word phrases · one candidate per line · maximum 1,000</label><textarea id="candidate-phrases" rows="5" placeholder="word1 word2 ... word12&#10;another candidate phrase ...">${candidatePhrases.replaceAll('&','&amp;').replaceAll('<','&lt;')}</textarea><div class="actions"><button class="primary" id="search-candidates">Check candidate phrases <span>→</span></button></div><div class="search-result" id="search-result" role="status" aria-live="polite"></div></section>
      <div class="warning"><span class="warning-icon">!</span><div><strong>Learning demo — never use this phrase or seed for real funds.</strong><p>This page does not send or save them, but it is not an audited wallet. Don’t screenshot, share, or enter a real recovery phrase into a website.</p></div></div>
      <div class="what-next"><span class="section-kicker">WHAT JUST HAPPENED?</span><p>${step2 ? `The phrase was transformed into a 512-bit seed using <strong>PBKDF2-HMAC-SHA512</strong>. This seed is secret wallet material, but it is <strong>not itself an Ethereum address or private key</strong>. The next lesson can derive a private key from it.` : phrase ? 'The words encode 128 bits of entropy plus a checksum. Click <strong>Derive seed</strong> to perform the BIP-39 transformation. No key or address is created.' : 'Generate 12 words first. Then you can run the BIP-39 transformation to derive a seed. No key or address is created in these steps.'}</p></div></section>
      <footer><span>SEEDLAB <span class="dim">· AN INTERACTIVE WALLET PRIMER</span></span><span>YOUR BROWSER · YOUR SESSION</span></footer>
    </main>`;
  document.querySelector('#generate').addEventListener('click', () => {
    try { phrase = generateMnemonic(wordlist, 128); seedHex = ''; copied = false; render(); }
    catch { alert('Secure randomness is unavailable in this browser context. Try a modern browser on HTTPS or localhost.'); }
  });
  document.querySelector('#derive')?.addEventListener('click', () => {
    seedHex = Array.from(mnemonicToSeedSync(phrase)).map((b) => b.toString(16).padStart(2, '0')).join('');
    render();
  });
  document.querySelector('#search-seed').addEventListener('input', (event) => { searchSeed = event.target.value; });
  document.querySelector('#search-passphrase').addEventListener('input', (event) => { searchPassphrase = event.target.value; });
  document.querySelector('#candidate-phrases').addEventListener('input', (event) => { candidatePhrases = event.target.value; });
  document.querySelector('#search-candidates').addEventListener('click', async () => {
    const target = document.querySelector('#search-result');
    const normalizedSeed = searchSeed.replace(/\s+/g, '').toLowerCase();
    if (!/^[0-9a-f]{128}$/.test(normalizedSeed)) {
      target.textContent = 'Enter a valid 512-bit seed as exactly 128 hexadecimal characters.';
      target.className = 'search-result error';
      return;
    }
    const candidates = candidatePhrases.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!candidates.length) {
      target.textContent = 'Add at least one candidate phrase, with one phrase per line.';
      target.className = 'search-result error';
      return;
    }
    if (candidates.length > 1000) {
      target.textContent = 'The demo is limited to 1,000 candidates per search.';
      target.className = 'search-result error';
      return;
    }
    target.textContent = `Checking ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} in this browser…`;
    target.className = 'search-result';
    await new Promise((resolve) => setTimeout(resolve, 0));
    let checked = 0;
    for (const candidate of candidates) {
      if (validateMnemonic(candidate, wordlist)) {
        const candidateSeed = Array.from(mnemonicToSeedSync(candidate, searchPassphrase)).map((b) => b.toString(16).padStart(2, '0')).join('');
        if (candidateSeed === normalizedSeed) {
          target.textContent = `Match found among the supplied candidates: ${candidate}`;
          target.className = 'search-result success';
          return;
        }
      }
      checked += 1;
      if (checked % 20 === 0) {
        target.textContent = `Checked ${checked} of ${candidates.length} candidates…`;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    target.textContent = `No match found in ${candidates.length} supplied candidates. This does not mean the seed is invalid; the original phrase may simply not be in your list.`;
    target.className = 'search-result';
  });
  document.querySelector('#back-to-phrase')?.addEventListener('click', () => {
    seedHex = '';
    render();
    document.querySelector('.phrase-box')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  document.querySelector('#copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(phrase); copied = true; render(); }
    catch { alert('Clipboard access is unavailable.'); }
  });
}
render();
