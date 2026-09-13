import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

test('照片预览被状态刷新后仍显示拍摄时间，不变为运行时长',()=>{
 const source=fs.readFileSync(new URL('./media-client.js',import.meta.url),'utf8');
 const fn=source.match(/  function updateTime\(s\)\{[^\n]+/)[0];
 let now=20000;const time={textContent:''};
 const sandbox={Date:{now:()=>now},sydney:at=>'拍摄时间 '+at,elapsed:()=> '错误的运行时长'};
 vm.runInNewContext(fn,sandbox);
 const session={mode:'photo',started:10000,previewPhoto:{captured_at:12345},node:{querySelector:()=>time}};
 sandbox.updateTime(session);assert.equal(time.textContent,'拍摄时间 12345');
 now=50000;sandbox.updateTime(session);assert.equal(time.textContent,'拍摄时间 12345');
});
