import test from 'node:test';
import assert from 'node:assert/strict';
import { createLink, listLinks, login, validate, logout, updateLink, revokeLink, revokeDevice, observerLocked, normalizeToken, newLinkToken, ttlFromInput, TOKEN_ALPHABET, SESSION_LEASE_MS } from './device-share.js';

function memory(){
  const map=new Map();
  return { map,
    async get(k){return map.get(k);},
    async put(k,v){map.set(k,v);},
    async delete(k){for(const x of Array.isArray(k)?k:[k])map.delete(x);},
  };
}
const T0=Date.parse('2026-09-18T12:00:00+10:00');

test('链接令牌：12 位、无 0/O/1/I，大小写归一', () => {
  const t=newLinkToken();
  assert.equal(t.length,12);assert.ok([...t].every(c=>TOKEN_ALPHABET.includes(c)));
  assert.equal(normalizeToken(t.toLowerCase()),t);
  assert.equal(normalizeToken('ABCDEFGHJK01'),null);
  assert.equal(ttlFromInput(undefined),3600000);assert.equal(ttlFromInput('permanent'),null);assert.equal(ttlFromInput('7d'),604800000);
  assert.throws(()=>ttlFromInput(1000),/至少一小时/);
});

test('创建默认一小时免密链接，请求编号去重，列表只含有效链接', async () => {
  const s=memory();
  const a=await createLink(s,{deviceId:'dev1',source:'device',requestId:'r1'},T0);
  const again=await createLink(s,{deviceId:'dev1',source:'device',requestId:'r1'},T0+1000);
  assert.equal(again.duplicate,true);assert.equal(again.link.token,a.link.token);
  assert.equal(a.link.expires_at,T0+3600000);assert.equal(a.link.password,null);
  const b=await createLink(s,{deviceId:'dev1',ttlMs:null,password:'pw',source:'admin'},T0);
  assert.equal(b.link.expires_at,null);assert.ok(b.link.password.hash);
  const list=await listLinks(s,'dev1',T0+3600001);
  assert.deepEqual(list.links.map(l=>l.token),[b.link.token]);
  assert.equal(list.links[0].remaining_ms,null);assert.equal(list.session,null);
});

test('免密登录直接进入；密码链接错误密码不踢人；新登录踢旧登录', async () => {
  const s=memory();
  const free=(await createLink(s,{deviceId:'dev1'},T0)).link;
  const locked=(await createLink(s,{deviceId:'dev1',password:'secret'},T0)).link;
  const first=await login(s,{token:free.token.toLowerCase()},T0);
  assert.equal(first.ok,true);assert.equal(first.generation,1);assert.equal(first.kicked,null);
  const ctx=await validate(s,first.cookie,T0+1000);
  assert.equal(ctx.device_id,'dev1');assert.equal(ctx.link_token,free.token);
  const wrong=await login(s,{token:locked.token,password:'nope',peer:'p1'},T0+2000);
  assert.equal(wrong.ok,false);assert.equal(wrong.status,401);
  assert.ok(await validate(s,first.cookie,T0+3000),'错误密码不能踢掉现有会话');
  const second=await login(s,{token:locked.token,password:'secret',peer:'p1'},T0+4000);
  assert.equal(second.ok,true);assert.equal(second.generation,2);assert.equal(second.kicked.session_id,first.session_id);
  assert.equal(await validate(s,first.cookie,T0+5000),null,'旧会话失效');
  assert.ok(await validate(s,second.cookie,T0+5000));
  assert.equal((await listLinks(s,'dev1',T0+5000)).session.link_token,locked.token);
});

test('密码连续错误 8 次后限速；不同设备会话互不影响', async () => {
  const s=memory();
  const l=(await createLink(s,{deviceId:'dev1',password:'x'},T0)).link;
  for(let i=0;i<8;i++)await login(s,{token:l.token,password:'bad',peer:'p'},T0+i);
  const r=await login(s,{token:l.token,password:'x',peer:'p'},T0+9);
  assert.equal(r.status,429);
  const other=(await createLink(s,{deviceId:'dev2'},T0)).link;
  const a=await login(s,{token:other.token},T0);const b=await login(s,{token:l.token,password:'x',peer:'q'},T0+70000);
  assert.ok(await validate(s,a.cookie,T0+70001));assert.ok(await validate(s,b.cookie,T0+70001));
});

test('当前会话给自己的链接设密码不被踢；其他人以后需要密码；改其他链接不影响当前会话', async () => {
  const s=memory();
  const l=(await createLink(s,{deviceId:'dev1'},T0)).link;
  const l2=(await createLink(s,{deviceId:'dev1'},T0)).link;
  const me=await login(s,{token:l.token},T0);
  const ctx=await validate(s,me.cookie,T0+1);
  const updated=await updateLink(s,{token:l.token,password:{action:'set',value:'pw'}},ctx,T0+2);
  assert.equal(updated.has_password,true);assert.equal(updated.expires_at,T0+3600000,'改密码不动截止时间');
  assert.ok(await validate(s,me.cookie,T0+3),'设密后当前会话继续有效');
  assert.equal((await login(s,{token:l.token},T0+4)).needs_password,true);
  await updateLink(s,{token:l2.token,ttl:'permanent'},ctx,T0+5);
  assert.ok(await validate(s,me.cookie,T0+6));
  await assert.rejects(updateLink(s,{token:l2.token,ttl:'1d'},{kind:'share',device_id:'dev9',session_id:'x'},T0+7),/其他设备/);
});

test('删除当前链接立即踢出；删除其他链接不踢；到期后不能登录也不能续用', async () => {
  const s=memory();
  const l=(await createLink(s,{deviceId:'dev1'},T0)).link;const l2=(await createLink(s,{deviceId:'dev1'},T0)).link;
  const me=await login(s,{token:l.token},T0);
  assert.equal((await revokeLink(s,l2.token,null,T0+1)).kicked,null);
  assert.ok(await validate(s,me.cookie,T0+2));
  const r=await revokeLink(s,l.token,null,T0+3);
  assert.equal(r.kicked.session_id,me.session_id);
  assert.equal(await validate(s,me.cookie,T0+4),null);
  const l3=(await createLink(s,{deviceId:'dev1'},T0)).link;
  const late=await login(s,{token:l3.token},T0+3600001);
  assert.equal(late.status,404);
  const ok=await login(s,{token:l3.token},T0+10);
  assert.equal(await validate(s,ok.cookie,T0+3600001),null,'链接到期后会话失效');
});

test('退出、租约与旁观锁、整机撤销', async () => {
  const s=memory();
  const l=(await createLink(s,{deviceId:'dev1'},T0)).link;
  const me=await login(s,{token:l.token},T0);
  assert.equal(await observerLocked(s,'dev1',T0+1),true);
  assert.equal(await observerLocked(s,'dev1',T0+SESSION_LEASE_MS+1),false,'租约到期后台恢复');
  assert.ok(await validate(s,me.cookie,T0+SESSION_LEASE_MS+2),'租约到期只影响后台写权限，会话本身仍有效');
  assert.equal(await observerLocked(s,'dev1',T0+SESSION_LEASE_MS+3),true,'校验续租约');
  assert.equal(await logout(s,me.cookie),true);
  assert.equal(await validate(s,me.cookie,T0+5),null);
  const again=await login(s,{token:l.token},T0+6);
  const r=await revokeDevice(s,'dev1',T0+7);
  assert.equal(r.kicked,true);assert.equal(await validate(s,again.cookie,T0+8),null);
  assert.equal((await listLinks(s,'dev1',T0+9)).links.length,0);
});
