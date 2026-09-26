'use strict';

/* 核验引擎单元测试：node test/verify.test.js */

const assert = require('assert');
const { verifyAll, STATUS, CONFLICT, WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n; // 录入先后用递增 createdAt 表示

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to, n) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 完整链并归仓
test('完整交接链 -> RETURNED', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三', 1),
    rec('p0', 3, '张三', '李四', 2),
    rec('p0', 8, '李四', '张三', 3),
    rec('p0', 12, '张三', WAREHOUSE, 4),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[0].chain.length, 4);
  assert.strictEqual(results[0].holder, WAREHOUSE);
});

// 2. 同一分钟多条可接续 -> AMBIGUOUS
test('同一分钟同一持有人多条可接续 -> CONFLICT/AMBIGUOUS', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三', 1),
    rec('p0', 5, '张三', '王五', 2),
    rec('p0', 5, '张三', '赵六', 3),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(results[0].conflict.records.length, 2);
  assert.strictEqual(results[0].conflict.minute, 5);
  assert.strictEqual(results[0].replayedCount, 1);
});

// 3. 持有人对不上 -> BROKEN
test('交出者不是当前持有人 -> CONFLICT/BROKEN', () => {
  const data = mkData(['灯'], [
    rec('p0', 2, WAREHOUSE, '王五', 1),
    rec('p0', 4, '李四', '钱七', 2),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.BROKEN);
  assert.strictEqual(results[0].conflict.holder, '王五');
  assert.strictEqual(results[0].conflict.records.length, 1);
});

// 4. 未归仓
test('全部重放但未归仓 -> NOT_RETURNED', () => {
  const data = mkData(['印'], [
    rec('p0', 1, WAREHOUSE, '周八', 1),
    rec('p0', 6, '周八', '孙七', 2),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.NOT_RETURNED);
  assert.strictEqual(results[0].holder, '孙七');
});

// 5. 同一分钟链式交接（A→B, B→C）可被识别
test('同一分钟链式交接按录入顺序连成唯一链', () => {
  const data = mkData(['枪'], [
    rec('p0', 3, WAREHOUSE, '甲', 1),
    rec('p0', 7, '甲', '乙', 2),
    rec('p0', 7, '乙', '丙', 3),
    rec('p0', 7, '丙', WAREHOUSE, 4),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[0].chain.length, 4);
});

// 6. 同分钟链式交接与录入顺序无关（倒序录入同样连成唯一链）
test('同一分钟链式交接与录入顺序无关', () => {
  const data = mkData(['鞭'], [
    rec('p0', 7, '乙', WAREHOUSE, 3),
    rec('p0', 7, '甲', '乙', 2),
    rec('p0', 7, WAREHOUSE, '甲', 1),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[0].chain.map((r) => r.to).join(','), ['甲', '乙', WAREHOUSE].join(','));
});

// 7. 同一分钟两条记录都无法从当前持有人接续 -> BROKEN，且都被定位
test('同一分钟多条记录均无法接续 -> BROKEN，全部定位', () => {
  const data = mkData(['锤'], [
    rec('p0', 7, '甲', '乙', 1),
    rec('p0', 7, '丙', '丁', 2),
  ]);  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.BROKEN);
  // 断链后另一条（仓库->甲）也无法执行，应一并被定位
  assert.strictEqual(results[0].conflict.records.length, 2);
});

// 9. 跨分钟：第一分钟正常，第二分钟才出现歧义，之前的链保留
test('歧义发生在后一分钟，之前的链保留', () => {
  const data = mkData(['旗'], [
    rec('p0', 1, WAREHOUSE, '甲', 1),
    rec('p0', 3, '甲', '乙', 2),
    rec('p0', 9, '乙', '丙', 3),
    rec('p0', 9, '乙', '丁', 4),
  ]);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(results[0].conflict.minute, 9);
  assert.strictEqual(results[0].chain.length, 2);
  assert.strictEqual(results[0].holder, '乙');
});

// 10. 无记录
test('无记录 -> NO_RECORDS', () => {
  const data = mkData(['空箱'], []);
  const { results } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.NO_RECORDS);
  assert.strictEqual(results[0].holder, WAREHOUSE);
});

// 11. 时间轴段数与持有人正确
test('时间轴段反映各持有人的起止分钟', () => {
  const data = mkData(['轴'], [
    rec('p0', 0, WAREHOUSE, '甲', 1),
    rec('p0', 5, '甲', '乙', 2),
    rec('p0', 5, '乙', WAREHOUSE, 3),
  ]);
  const { results } = verifyAll(data);
  const segs = results[0].timeline.segments;
  assert.deepStrictEqual(
    segs.map((s) => [s.holder, s.startMinute, s.endMinute]),
    [[WAREHOUSE, 0, 0], ['甲', 0, 5], ['乙', 5, 5]]
  );
});

// 12. 未归仓时间轴末段开放到演出末分钟
test('未归仓时间轴有开放段且终止于演出末分钟', () => {
  const data = mkData(['伞'], [
    rec('p0', 2, WAREHOUSE, '甲', 1),
    rec('p0', 6, '甲', '乙', 2),
  ]);
  const { results } = verifyAll(data);
  const last = results[0].timeline.segments.at(-1);
  assert.strictEqual(last.holder, '乙');
  assert.strictEqual(last.open, true);
  assert.strictEqual(last.endMinute, 6);
});

// 13. 多道具独立核验，互不影响
test('多道具各自独立核验', () => {
  const data = mkData(['好', '坏'], [
    rec('p0', 1, WAREHOUSE, '甲', 1),
    rec('p0', 2, '甲', WAREHOUSE, 2),
    rec('p1', 1, WAREHOUSE, '乙', 3),
    rec('p1', 2, '乙', '丙', 4),
  ]);
  const { results, summary } = verifyAll(data);
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[1].status, STATUS.NOT_RETURNED);
  assert.strictEqual(summary.returned, 1);
  assert.strictEqual(summary.notReturned, 1);
});

// 14. 引用已删除道具的记录进入 orphanRecords
test('孤儿记录被统计且不参与核验', () => {
  const data = {
    props: [{ id: 'p0', name: '仅存', note: '', createdAt: 1 }],
    records: [
      rec('p0', 1, WAREHOUSE, '甲', 1),
      rec('pX', 2, '甲', '乙', 2),
    ],
  };
  const out = verifyAll(data);
  assert.strictEqual(out.orphanRecords.length, 1);
  assert.strictEqual(out.results[0].status, STATUS.NOT_RETURNED);
});

// 15. 同分钟长链（数千条可接续交接）：近线性完成，链序与最终持有人正确
test('同分钟数千条链式交接 -> 近线性重放且链序正确', () => {
  const n = 20000;
  const records = [];
  // 倒序录入：重放须与录入顺序无关（仓库 -> 甲1 -> ... -> 甲(n-1) -> 仓库）
  for (let k = n - 1; k >= 0; k -= 1) {
    records.push(rec('p0', 5, k === 0 ? WAREHOUSE : `甲${k}`, k === n - 1 ? WAREHOUSE : `甲${k + 1}`, k));
  }
  const data = mkData(['长链'], records);
  const startedAt = Date.now();
  const { results } = verifyAll(data);
  const elapsed = Date.now() - startedAt;
  assert.strictEqual(results[0].status, STATUS.RETURNED);
  assert.strictEqual(results[0].chain.length, n);
  assert.strictEqual(results[0].replayedCount, n);
  assert.strictEqual(results[0].totalCount, n);
  assert.strictEqual(results[0].chain[0].from, WAREHOUSE);
  assert.strictEqual(results[0].chain[0].to, '甲1');
  assert.strictEqual(results[0].chain[n - 2].from, `甲${n - 2}`);
  assert.strictEqual(results[0].chain[n - 2].to, `甲${n - 1}`);
  assert.strictEqual(results[0].chain[n - 1].to, WAREHOUSE);
  assert.strictEqual(results[0].holder, WAREHOUSE);
  // 近线性回归阈值：旧的逐步扫描+复制实现同等规模需十几秒，留出充足余量
  assert.ok(elapsed < 5000, `同分钟 ${n} 条长链重放应近线性完成，实际耗时 ${elapsed}ms`);
});

// 16. 同分钟长链末端出现多条可接续 -> AMBIGUOUS，冲突前链保留、全部可接续记录按序定位
test('同分钟长链末端多条可接续 -> AMBIGUOUS，前链保留且全部定位', () => {
  const n = 5000;
  const records = [];
  // 长链：仓库 -> 甲1 -> ... -> 甲(n-1)（同分钟，倒序录入），共 n-1 条
  for (let k = n - 1; k >= 1; k -= 1) {
    records.push(rec('p0', 7, k === 1 ? WAREHOUSE : `甲${k - 1}`, `甲${k}`, k));
  }
  // 长链末端持有人同时交给三个人 -> 歧义
  records.push(rec('p0', 7, `甲${n - 1}`, '乙', n));
  records.push(rec('p0', 7, `甲${n - 1}`, '丙', n + 1));
  records.push(rec('p0', 7, `甲${n - 1}`, '丁', n + 2));
  const { results } = verifyAll(mkData(['长链歧义'], records));
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(results[0].conflict.minute, 7);
  assert.strictEqual(results[0].conflict.holder, `甲${n - 1}`);
  // 冲突前链完整保留（n-1 条），顺序与唯一链一致
  assert.strictEqual(results[0].chain.length, n - 1);
  assert.strictEqual(results[0].chain[0].from, WAREHOUSE);
  assert.strictEqual(results[0].chain[n - 2].to, `甲${n - 1}`);
  assert.strictEqual(results[0].holder, `甲${n - 1}`);
  // 该持有人的全部可接续记录按录入先后（createdAt）顺序定位
  assert.strictEqual(results[0].conflict.records.length, 3);
  assert.deepStrictEqual(
    results[0].conflict.recordRefs.map((r) => r.to),
    ['乙', '丙', '丁']
  );
});

// 17. 同分钟长链归仓后仍有无法接续记录 -> BROKEN，定位当分钟全部未执行记录
test('同分钟长链后断链 -> BROKEN，定位当分钟全部未执行记录且顺序不变', () => {
  const n = 5000;
  const records = [];
  // 长链：仓库 -> 甲1 -> ... -> 甲(n-1) -> 仓库（同分钟，倒序录入），共 n 条
  for (let k = n - 1; k >= 0; k -= 1) {
    records.push(rec('p0', 9, k === 0 ? WAREHOUSE : `甲${k}`, k === n - 1 ? WAREHOUSE : `甲${k + 1}`, k));
  }
  // 链已归仓后，当分钟仍有两条交出者对不上的记录 -> 断链
  records.push(rec('p0', 9, '张三', '李四', n + 1));
  records.push(rec('p0', 9, '王五', '赵六', n + 2));
  const { results } = verifyAll(mkData(['长链断链'], records));
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.BROKEN);
  assert.strictEqual(results[0].conflict.minute, 9);
  assert.strictEqual(results[0].conflict.holder, WAREHOUSE);
  // 冲突前链完整保留（n 条），最终持有人为仓库
  assert.strictEqual(results[0].chain.length, n);
  assert.strictEqual(results[0].holder, WAREHOUSE);
  // 当分钟全部未执行记录按录入先后顺序定位
  assert.deepStrictEqual(
    results[0].conflict.recordRefs.map((r) => [r.from, r.to]),
    [['张三', '李四'], ['王五', '赵六']]
  );
  assert.strictEqual(results[0].conflict.records.length, 2);
});

// 18. 同一持有人数千条可接续 -> AMBIGUOUS，全部记录按序定位
test('同一持有人数千条可接续记录 -> AMBIGUOUS 全部按序定位', () => {
  const n = 3000;
  const records = [];
  for (let k = n - 1; k >= 0; k -= 1) {
    records.push(rec('p0', 4, WAREHOUSE, `甲${k}`, k));
  }
  const { results } = verifyAll(mkData(['扇'], records));
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(results[0].conflict.holder, WAREHOUSE);
  assert.strictEqual(results[0].conflict.records.length, n);
  // 定位顺序与记录排序（createdAt 升序）一致：先录入的排在前面
  assert.strictEqual(results[0].conflict.recordRefs[0].to, `甲${n - 1}`);
  assert.strictEqual(results[0].conflict.recordRefs[n - 1].to, '甲0');
  assert.strictEqual(results[0].chain.length, 0);
});

// 19. 大量记录均无法接续 -> BROKEN，当分钟全部未执行记录按序定位
test('同分钟数千条记录均无法接续 -> BROKEN 全部按序定位', () => {
  const n = 3000;
  const records = [rec('p0', 6, WAREHOUSE, '甲', 0)];
  // 执行唯一可接续记录后持有人为「甲」，其余记录交出者均不是「甲」
  for (let k = 0; k < n; k += 1) {
    records.push(rec('p0', 6, `张${k}`, `李${k}`, k + 1));
  }
  const { results } = verifyAll(mkData(['锤'], records));
  assert.strictEqual(results[0].status, STATUS.CONFLICT);
  assert.strictEqual(results[0].conflict.type, CONFLICT.BROKEN);
  assert.strictEqual(results[0].conflict.holder, '甲');
  assert.strictEqual(results[0].chain.length, 1);
  assert.strictEqual(results[0].conflict.records.length, n);
  // 全部未执行记录按记录排序（createdAt 升序）定位
  assert.strictEqual(results[0].conflict.recordRefs[0].from, '张0');
  assert.strictEqual(results[0].conflict.recordRefs[n - 1].from, `张${n - 1}`);
});

console.log(`\n全部 ${passed} 个测试通过 ✔`);
