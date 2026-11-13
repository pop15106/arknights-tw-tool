import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLocalImportText } from '../src/importers/local-file.ts';
import { createPersonalDataset, createDemoDataset, createDemoImport } from '../src/demo.ts';
import { sealDataset } from '../src/domain/model.ts';

const date='2026-11-13T00:00:00.000Z';
const raw=JSON.stringify({format:'skport-offline-research',schemaVersion:1,gameData:{code:0,data:{chars:[{charId:'char_test',level:1,defaultSkillId:'',defaultEquipId:'',skills:[],equip:[]}]}}});
async function catalog(){return sealDataset({metadata:{id:'arknights-tw-public-catalog',version:'test-1',product:'arknights',server:'tw',namespace:'personal',validFrom:date,acquiredAt:date,source:'合成繁中資料',licenseStatus:'self-authored'},operators:[{id:'char_test',displayName:'測試中文名',aliases:[],rarity:1,profession:'重裝',branch:'鐵衛',faction:'測試',skills:[],modules:[],availability:'unknown'}]});}
test('研究JSON先確認服別及個人庫，再本機轉換；不會發送帳號JSON',async()=>{
  let requested='';
  const definitions=await catalog();
  const fetcher:typeof fetch=async(input,init)=>{requested=String(input);assert.equal(init?.body,undefined);return new Response(JSON.stringify(definitions));};
  const options={dataset:await createPersonalDataset(),confirmedTw:true,importedAt:date,fetcher};
  await assert.rejects(prepareLocalImportText(raw,{...options,confirmedTw:false}),/確認/);
  await assert.rejects(prepareLocalImportText(raw,{...options,dataset:await createDemoDataset()}),/個人/);
  assert.equal(requested,'');
  const result=await prepareLocalImportText(raw,options);
  assert.equal(requested,'/api/game-data/operators');
  assert.equal(result.format,'arknights-roster-import');
  assert.equal(result.candidates.length,1);
  assert.equal(result.dataset.operators[0].displayName,'測試中文名');
  assert.equal(result.candidates[0].fields.equippedSkill.status,'unknown');
});
test('標準匯入不連線；資料服務失敗、未知ID與校驗錯誤明確拒絕',async()=>{
  const demo=await createDemoDataset();
  const normal=createDemoImport(demo);
  const unused:typeof fetch=async()=>{throw new Error('不應連線');};
  assert.deepEqual(await prepareLocalImportText(JSON.stringify(normal),{dataset:demo,confirmedTw:false,importedAt:date,fetcher:unused}),normal);
  const options={dataset:await createPersonalDataset(),confirmedTw:true,importedAt:date};
  await assert.rejects(prepareLocalImportText(raw,{...options,fetcher:unused}),/遊戲資料服務/);
  const definitions=await catalog();definitions.operators[0].displayName='竄改';
  await assert.rejects(prepareLocalImportText(raw,{...options,fetcher:async()=>new Response(JSON.stringify(definitions))}),/校驗/);
});
