import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bitcoinAddressForKey, findBitcoinPublicKey, lookupBitcoinPublicKey } from '../src/bitcoin-public-key.js';
import { parsePublicKeyFile, searchPublicKeys, validatePointSearchRange } from '../src/public-key-search.js';

const point = secp256k1.Point.BASE;
const key = Buffer.from(point.toBytes(true)).toString('hex');
const uncompressed = Buffer.from(point.toBytes(false)).toString('hex');
const h = (bytes) => Buffer.from(ripemd160(sha256(bytes))).toString('hex');
const keyhash = h(Buffer.from(key, 'hex'));
const redeem = `0014${keyhash}`;
const addr = (type) => bitcoinAddressForKey(key, type);
function tx(type) {
  const address = addr(type);
  const script = type === 'p2pkh' ? `76a914${keyhash}88ac` : type === 'p2wpkh' ? redeem : `a914${h(Buffer.from(redeem,'hex'))}87`;
  return { txid: 'ab'.repeat(32), status: { confirmed: true }, vin: [{ prevout: { scriptpubkey: script, scriptpubkey_address: address }, scriptsig: type === 'p2pkh' ? `01ff21${key}` : type === 'p2sh-p2wpkh' ? `16${redeem}` : '', witness: type === 'p2pkh' ? [] : ['ff', key] }] };
}

test('extracts only supported spending keys and validates the address commitment', () => {
  assert.equal(addr('p2pkh'), '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
  for (const type of ['p2pkh', 'p2wpkh', 'p2sh-p2wpkh']) {
    const result = findBitcoinPublicKey(addr(type), [tx(type)]);
    assert.equal(result.publicKey, `0x${uncompressed}`); assert.equal(result.type, type);
    const broken = tx(type); broken.vin[0].prevout.scriptpubkey = '0014'+'ff'.repeat(20);
    assert.equal(findBitcoinPublicKey(addr(type), [broken]), null);
    assert.equal(findBitcoinPublicKey(addr(type), [{ ...tx(type), vin: [] }]), null);
  }
  const broken = tx('p2sh-p2wpkh'); broken.vin[0].scriptsig = '160014'+'ff'.repeat(20);
  assert.equal(findBitcoinPublicKey(addr('p2sh-p2wpkh'), [broken]), null);
  assert.equal(findBitcoinPublicKey(addr('p2pkh').toLowerCase(), [tx('p2pkh')]), null);
});

test('Bitcoin results can be loaded into BSGS and mismatches are rejected', async () => {
  const header = 'address\ttransaction_hash\tpublic_key_uncompressed\tstatus';
  for (const type of ['p2pkh','p2wpkh','p2sh-p2wpkh']) {
    const row = `${addr(type)}\t0x${'ab'.repeat(32)}\t0x${uncompressed}\tok`;
    const targets = parsePublicKeyFile(`${header}\n${row}`);
    const result = await searchPublicKeys(targets, validatePointSearchRange('1','2'));
    assert.equal(result.matches[0].scalar,'1');
    assert.throws(() => parsePublicKeyFile(`${header}\n${row.replace(addr(type), bitcoinAddressForKey(secp256k1.Point.BASE.multiply(2n).toBytes(true), type))}`), /does not match/);
  }
});

test('explorer pagination is bounded and does not mistake missing keys for a match', async () => {
  let calls=0;
  const page=Array.from({length:25},(_,i)=>({txid:i.toString(16).padStart(64,'0'),status:{confirmed:true},vin:[]}));
  const mock=async () => ({ok:true,json:async()=>{calls++; return page;}});
  await assert.rejects(lookupBitcoinPublicKey(addr('p2pkh'), {fetchImpl:mock,maxPages:3}), /repeated/);
  assert.equal(calls,2);
  calls=0;
  const paged=async () => ({ok:true,json:async()=>{calls++; return page.map((v,i)=>({...v,txid:(i+calls*100).toString(16).padStart(64,'0')}));}});
  const result=await lookupBitcoinPublicKey(addr('p2pkh'),{fetchImpl:paged,maxPages:2});
  assert.equal(calls,2); assert.equal(result.historyComplete,false); assert.equal(result.status,'not_found');
  const found=await lookupBitcoinPublicKey(addr('p2pkh'),{fetchImpl:async()=>({ok:true,json:async()=>[tx('p2pkh')]})});
  assert.equal(found.publicKey, `0x${uncompressed}`);
  await assert.rejects(lookupBitcoinPublicKey(addr('p2pkh'),{fetchImpl:async()=>({ok:false,status:429})}), /429/);
});
