'use strict';

/**
 * 人员同时持有上限排查引擎（只读，即时重放，不改写交接记录与签收）。
 *
 * 输入「人员、起止分钟、持有件数上限」，沿用现有「同分钟唯一交接链」规则
 * 逐件重放窗口结束分钟（含）以内的记录，以交接分钟为边界，合并各道具在
 * 该分钟全部交接完成后的持有人，得到该人员在窗口内每一段的持有件数：
 *
 * - 状态点：窗口起始分钟 + 窗口内全部交接分钟。每个状态点取该分钟全部
 *   交接完成后的持有人；交接分钟之间持有状态不变，相邻同值状态点合并为
 *   连续分钟段（半开区间 [startMinute, endMinute)，末段延伸至窗口结束
 *   分钟之后，即覆盖到结束分钟末尾）。
 * - 冲突道具从冲突分钟起视为未知：冲突当分钟的最终持有人即无法判定，
 *   该道具在冲突分钟及以后的状态点一律记为未知；窗口结束分钟之后才发生
 *   的冲突不参与重放，不影响本次结果。
 * - 判定：某状态点已知持有数（确定由该人持有的件数）已严格超过上限时，
 *   无论是否仍含未知道具，均判为「确定超限」；否则只要该时段仍含未知
 *   道具，即标为「无法判定」（不把未知计为零）；无未知道具且已知持有数
 *   不超过上限时为「确定未超限」。
 * - 已知峰值：窗口内各状态点已知持有数的最大值，及达到峰值的连续分钟段。
 *
 * 实现要点（事件增量维护，不在每个状态点扫描全部道具及历史记录）：
 * 1. 交接记录先按道具一次分组，各道具沿同分钟唯一链重放（只取窗口结束
 *    分钟及以前的记录）；
 * 2. 把「分钟末持有人变化」（同分钟链式交接只保留该分钟最终持有人）与
 *    「首个冲突分钟」统一转换为按分钟排序的事件——前者是该道具在已知
 *    持有人之间的一次增量迁移，后者把该道具迁入去向未知集合；
 * 3. 按时间顺序增量维护该人员的「已知持有道具」与「去向未知道具」两个
 *    集合，只在有事件的分钟切段、求值，每个事件对集合至多两次 O(1)
 *    增删，处理量随记录数与状态点数近线性增长，与状态点上的道具总数无关。
 */

const { WAREHOUSE, sortRecords, replayPropRecords } = require('./verify');

/** 时段判定类型 */
const SEGMENT_STATUS = {
  OVER: 'OVER',       // 已知持有数已超过上限：确定超限
  UNKNOWN: 'UNKNOWN', // 含未知道具且已知持有数未超上限：无法判定（未知不计为零）
  OK: 'OK',           // 无未知道具且已知持有数未超上限：确定未超限
};

/**
 * 人员同时持有上限排查。
 * @param {{props: Array, records: Array}} data 当前数据（只读）
 * @param {string} person 人员姓名（精确匹配）
 * @param {number} startMinute 起始分钟（含）
 * @param {number} endMinute 结束分钟（含，须 >= startMinute）
 * @param {number} limit 持有件数上限（已知持有数严格大于它才算超限）
 * @returns {object}
 */
function investigateHoldingLimit(data, person, startMinute, endMinute, limit) {
  const props = data.props || [];
  const records = data.records || [];

  // 1) 交接记录按道具一次分组，只取窗口结束分钟（含）以前的记录；
  //    窗口外的后续交接与冲突不影响本次结果（孤儿记录自然不进任何道具分组）
  const recordsByProp = new Map(); // propId -> 该道具记录（保持原顺序，随后逐件排序）
  for (const r of records) {
    if (Number(r.minute) > endMinute) continue;
    let arr = recordsByProp.get(r.propId);
    if (!arr) {
      arr = [];
      recordsByProp.set(r.propId, arr);
    }
    arr.push(r);
  }

  // 2) 逐件沿现有同分钟唯一链重放，转换为按分钟排序的事件：
  //    HOLDER { minute, propIndex, holder }：该分钟全部交接完成后持有人变为 holder
  //    UNKNOWN { minute, propIndex }：自该分钟（含）起道具去向未知（首个冲突分钟）
  const events = [];
  const conflicts = [];
  const conflictMinuteByIndex = new Map(); // propIndex -> 首个冲突分钟（未知起点）

  props.forEach((prop, propIndex) => {
    const propRecords = sortRecords(recordsByProp.get(prop.id) || []);
    const replay = replayPropRecords(propRecords);

    // 同分钟链式交接只保留该分钟最终持有人；冲突分钟的最终状态即未知，
    // 该分钟部分归约出的记录不再产生持有人事件（与「冲突分钟起未知」口径一致）。
    // chain 按分钟升序，同分钟记录连续出现，只需回看本道具上一事件即可归并
    let lastEvent = null;
    for (const rec of replay.chain) {
      const minute = Number(rec.minute);
      if (!replay.ok && minute === replay.conflict.minute) continue;
      if (lastEvent && lastEvent.minute === minute) {
        lastEvent.holder = rec.to;
      } else {
        lastEvent = { minute, propIndex, type: 'HOLDER', holder: rec.to };
        events.push(lastEvent);
      }
    }

    if (!replay.ok) {
      const conflictMinute = Number(replay.conflict.minute);
      events.push({ minute: conflictMinute, propIndex, type: 'UNKNOWN' });
      conflictMinuteByIndex.set(propIndex, conflictMinute);
      conflicts.push({
        propId: prop.id,
        propName: prop.name,
        conflictMinute,
        conflictType: replay.conflict.type,
        reason: replay.conflict.reason,
        conflictRecordIds: replay.conflict.records || [],
      });
    }
  });

  // 事件按分钟排序（同分钟按道具，仅为处理顺序稳定）；随后单指针顺序消费
  events.sort((a, b) => a.minute - b.minute || a.propIndex - b.propIndex);

  // 3) 增量维护两个集合：
  //    heldSet —— 当前状态点已知持有人恰为该人员的道具
  //    unknownSet —— 自冲突分钟起去向未知的道具
  // 每件道具初始持有人恒为「仓库」：查询仓库时起点前即持有全部道具
  const heldSet = new Set();
  const unknownSet = new Set();
  if (person === WAREHOUSE) {
    for (let i = 0; i < props.length; i += 1) heldSet.add(i);
  }

  function applyEvent(ev) {
    if (ev.type === 'UNKNOWN') {
      heldSet.delete(ev.propIndex);
      unknownSet.add(ev.propIndex);
    } else {
      unknownSet.delete(ev.propIndex);
      if (ev.holder === person) heldSet.add(ev.propIndex);
      else heldSet.delete(ev.propIndex);
    }
  }

  let eventPos = 0;
  function applyAt(minute) {
    while (eventPos < events.length && events[eventPos].minute === minute) {
      applyEvent(events[eventPos]);
      eventPos += 1;
    }
  }

  // 窗口起始分钟之前的事件先重放完毕，得到起点交接前状态
  while (eventPos < events.length && events[eventPos].minute < startMinute) {
    applyEvent(events[eventPos]);
    eventPos += 1;
  }

  // 状态点求值：由两个集合直接得到已知持有 / 未知清单（按下标序，即道具录入顺序）
  function evaluate() {
    const held = [...heldSet].sort((a, b) => a - b);
    const unknown = [...unknownSet].sort((a, b) => a - b);
    const knownCount = held.length;
    const status =
      knownCount > limit
        ? SEGMENT_STATUS.OVER
        : unknown.length > 0
          ? SEGMENT_STATUS.UNKNOWN
          : SEGMENT_STATUS.OK;
    return { status, knownCount, held, unknown };
  }

  const sameSet = (seg, held, unknown) =>
    seg.held.length === held.length &&
    seg.unknown.length === unknown.length &&
    held.every((idx) => seg.heldSet.has(idx)) &&
    unknown.every((idx) => seg.unknownSet.has(idx));

  // 逐事件分钟切段：只在有事件的分钟求值一次，不在状态点扫描全部道具及历史记录
  const segments = [];
  let peakCount = 0;

  function openSegment(m) {
    const ev = evaluate();
    if (ev.knownCount > peakCount) peakCount = ev.knownCount;

    const last = segments[segments.length - 1];
    // 相邻同值（判定、持有集合、未知集合均相同）的状态点合并为连续分钟段
    if (last && last.status === ev.status && sameSet(last, ev.held, ev.unknown)) {
      last.endMinute = endMinute + 1;
      return;
    }
    segments.push({
      status: ev.status,
      startMinute: m,
      endMinute: endMinute + 1,
      knownCount: ev.knownCount,
      held: ev.held,
      unknown: ev.unknown,
      heldSet: new Set(ev.held),
      unknownSet: new Set(ev.unknown),
    });
  }

  // 窗口起始分钟：先应用该分钟全部交接（含冲突），再开第一段
  applyAt(startMinute);
  openSegment(startMinute);

  // 其余状态点 = 窗口内其余有事件的分钟；每到一个事件分钟，关闭当前段后重算
  while (eventPos < events.length) {
    const minute = events[eventPos].minute; // 已 >= startMinute，且记录均 <= endMinute
    segments[segments.length - 1].endMinute = minute;
    applyAt(minute);
    openSegment(minute);
  }

  // 以下输出口径与逐状态点扫描完全一致，仅把道具下标还原为道具信息
  const toHeldProp = (idx) => ({ propId: props[idx].id, propName: props[idx].name });
  const toUnknownProp = (idx) => ({
    propId: props[idx].id,
    propName: props[idx].name,
    conflictMinute: conflictMinuteByIndex.get(idx),
  });

  const fmtRange = (s) => `第${s.startMinute}–${s.endMinute - 1}分钟`;

  // 超过上限的连续分钟段（确定超限；段内仍含未知道具时一并标注）
  const overSegments = segments
    .filter((s) => s.status === SEGMENT_STATUS.OVER)
    .map((s) => ({
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      count: s.knownCount,
      props: s.held.map(toHeldProp),
      unknownProps: s.unknown.map(toUnknownProp),
      note:
        `${fmtRange(s)}已知确定持有 ${s.knownCount} 件，超过上限 ${limit} 件` +
        (s.unknown.length
          ? `；另有 ${s.unknown.length} 件道具自冲突分钟起去向未知，实际持有可能更多`
          : '') +
        '。',
    }));

  // 无法判定的连续分钟段（已知持有数未超上限，但仍含未知道具，未知不计为零）
  const undeterminedSegments = segments
    .filter((s) => s.status === SEGMENT_STATUS.UNKNOWN)
    .map((s) => ({
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      knownCount: s.knownCount,
      knownProps: s.held.map(toHeldProp),
      unknownProps: s.unknown.map(toUnknownProp),
      note:
        `${fmtRange(s)}已知确定持有 ${s.knownCount} 件（未超过上限 ${limit} 件），但 ` +
        `${s.unknown
          .map(
            (idx) =>
              `「${props[idx].name}」自第${conflictMinuteByIndex.get(idx)}分钟冲突起`
          )
          .join('、')}` +
        ' 去向未知，无法判定是否超限（未知不计为零）。',
    }));

  // 已知峰值：窗口内各状态点已知持有数的最大值，及达到峰值的连续分钟段
  const peak = {
    count: peakCount,
    segments: segments
      .filter((s) => s.knownCount === peakCount)
      .map((s) => ({ startMinute: s.startMinute, endMinute: s.endMinute })),
  };

  // 涉及道具：各超限段中确定由该人持有的道具并集（按道具名排序）
  const involvedMap = new Map();
  for (const s of overSegments) {
    for (const p of s.props) involvedMap.set(p.propId, p);
  }
  const involvedProps = [...involvedMap.values()].sort((a, b) =>
    String(a.propName).localeCompare(String(b.propName), 'zh')
  );

  conflicts.sort(
    (a, b) =>
      a.conflictMinute - b.conflictMinute ||
      String(a.propName).localeCompare(String(b.propName), 'zh')
  );

  return {
    person,
    startMinute,
    endMinute,
    limit,
    warehouse: WAREHOUSE,
    overSegments,
    undeterminedSegments,
    peak,
    involvedProps,
    conflicts,
    summary: {
      totalProps: props.length,
      overSegmentCount: overSegments.length,
      undeterminedSegmentCount: undeterminedSegments.length,
      peakCount,
      conflictPropCount: conflicts.length,
      hasOver: overSegments.length > 0,
    },
  };
}

module.exports = { SEGMENT_STATUS, investigateHoldingLimit };
