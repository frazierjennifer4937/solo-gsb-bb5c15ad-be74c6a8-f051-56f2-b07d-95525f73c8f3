'use strict';

/**
 * 人员同时持有上限排查引擎（只读，即时重放，不改写交接记录与签收）。
 *
 * 输入「人员、起止分钟、持有件数上限」，分三步得到该人员在窗口内每一段的
 * 持有件数，不在每个状态点扫描全部道具及历史记录：
 *
 * 1. 分组重放：交接记录先按道具分组（一次遍历，只保留窗口结束分钟（含）
 *    以前的记录，窗口外的后续交接与冲突不参与），各道具沿用现有
 *    「同分钟唯一交接链」规则重放，得到交接链与首个冲突。
 * 2. 事件转换：把每件道具的「分钟末持有人变化」（同分钟链式交接只保留
 *    该分钟全部交接完成后的最终持有人；同分钟内交出又接回等净变化为零的
 *    分钟不产生事件）与「首个冲突分钟」转换为事件——只有会改变「该人员
 *    已知持有集合 / 去向未知道具集合」的变化才产生事件，与两者无关的
 *    持有人变化（他人之间的交接）不切段。
 * 3. 事件扫描：按分钟升序增量维护这两个集合——起始分钟（含）以前的事件
 *    先归入起点状态，之后每个事件分钟即一个状态点（取该分钟全部交接完成
 *    后的状态），段为半开区间 [startMinute, endMinute)，末段延伸至窗口
 *    结束分钟之后（即覆盖到结束分钟末尾）。每个事件都改变上述集合，
 *    因此事件分钟即分段边界，等价于逐状态点求值后合并相邻同值段。
 *
 * 判定与展示口径：
 * - 冲突道具从冲突分钟（含）起视为未知：冲突当分钟的最终持有人即无法判定，
 *   该道具在冲突分钟及以后一律记为未知；窗口结束分钟之后才发生的冲突
 *   不参与重放，不影响本次结果。
 * - 某时段已知持有数（确定由该人持有的件数）已严格超过上限时，无论是否
 *   仍含未知道具，均判为「确定超限」；否则只要该时段仍含未知道具，即标为
 *   「无法判定」（不把未知计为零）；无未知道具且已知持有数不超过上限时为
 *   「确定未超限」。
 * - 已知峰值：窗口内各状态点已知持有数的最大值，及达到峰值的连续分钟段。
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

  // 1) 交接记录按道具分组（一次遍历）：只保留窗口结束分钟（含）以前的记录，
  //    窗口外的后续交接与冲突不参与本次排查
  const recordsByProp = new Map(); // propId -> 该道具窗口内的记录（未排序）
  for (const r of records) {
    if (Number(r.minute) > endMinute) continue;
    const list = recordsByProp.get(r.propId);
    if (list) list.push(r);
    else recordsByProp.set(r.propId, [r]);
  }

  // 2) 各道具沿现有同分钟唯一链重放，把「分钟末持有人变化」与「首个冲突分钟」
  //    转换为事件；只有会改变该人员已知持有集合 / 去向未知道具集合的变化才产生事件
  const eventsByMinute = new Map(); // 分钟 -> 该分钟的事件数组
  const conflicts = [];
  const addEvent = (minute, ev) => {
    const list = eventsByMinute.get(minute);
    if (list) list.push(ev);
    else eventsByMinute.set(minute, [ev]);
  };

  props.forEach((prop, propIdx) => {
    const propRecords = recordsByProp.get(prop.id);
    const replay = replayPropRecords(propRecords ? sortRecords(propRecords) : []);
    const conflictMinute = replay.ok ? null : replay.conflict.minute;

    // 分钟末持有人序列：同分钟链式交接只保留该分钟全部交接完成后的最终持有人；
    // 冲突分钟（含）起的部分链不计——该道具自冲突分钟起已转为未知
    const states = [];
    for (const rec of replay.chain) {
      if (conflictMinute !== null && rec.minute >= conflictMinute) break;
      const last = states[states.length - 1];
      if (last && last.minute === rec.minute) last.holder = rec.to;
      else states.push({ minute: rec.minute, holder: rec.to });
    }

    // 分钟末持有人相对此前有净变化、且变化涉及该人员（由其交出或交给他）才产生事件
    let prevHolder = WAREHOUSE;
    for (const st of states) {
      const h = st.holder;
      if (h !== prevHolder && (prevHolder === person || h === person)) {
        addEvent(st.minute, {
          kind: 'holder',
          propIdx,
          propId: prop.id,
          propName: prop.name,
          enter: h === person, // true=该人员接过（进入已知持有），false=该人员交出
        });
      }
      prevHolder = h;
    }

    // 首个冲突分钟：该道具自冲突分钟（含）起转为未知（冲突当分钟的最终持有人即无法判定）
    if (conflictMinute !== null) {
      addEvent(conflictMinute, {
        kind: 'conflict',
        propIdx,
        propId: prop.id,
        propName: prop.name,
        conflictMinute,
      });
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

  // 3) 事件扫描：按分钟升序增量维护该人员的已知持有道具与去向未知道具。
  //    每个事件都改变这两个集合之一，故事件分钟即分段边界，无需再合并同值段
  const held = new Map();    // propId -> { propIdx, propId, propName }：已知由该人持有
  const unknown = new Map(); // propId -> { propIdx, propId, propName, conflictMinute }：去向未知
  // 人员为「仓库」时全部道具初始即在仓（视为已知持有），随后由事件增量调整
  if (person === WAREHOUSE) {
    props.forEach((prop, propIdx) => {
      held.set(prop.id, { propIdx, propId: prop.id, propName: prop.name });
    });
  }

  const applyEvent = (ev) => {
    if (ev.kind === 'conflict') {
      // 冲突分钟起转为未知：先移出已知持有（若在其中），再记入未知道具
      held.delete(ev.propId);
      unknown.set(ev.propId, {
        propIdx: ev.propIdx,
        propId: ev.propId,
        propName: ev.propName,
        conflictMinute: ev.conflictMinute,
      });
    } else if (ev.enter) {
      held.set(ev.propId, { propIdx: ev.propIdx, propId: ev.propId, propName: ev.propName });
    } else {
      held.delete(ev.propId);
    }
  };

  const eventMinutes = [...eventsByMinute.keys()].sort((a, b) => a - b);
  const segments = [];
  let peakCount = 0;

  // 当前集合快照为一个连续分钟段（道具清单按道具登记顺序输出，与逐点求值口径一致）
  const emitSegment = (fromMinute, toMinute) => {
    const heldProps = [...held.values()]
      .sort((a, b) => a.propIdx - b.propIdx)
      .map((p) => ({ propId: p.propId, propName: p.propName }));
    const unknownProps = [...unknown.values()]
      .sort((a, b) => a.propIdx - b.propIdx)
      .map((p) => ({ propId: p.propId, propName: p.propName, conflictMinute: p.conflictMinute }));
    const knownCount = heldProps.length;
    // 已知持有数已超上限：无论是否含未知道具均确定超限；
    // 否则只要仍含未知道具即无法判定（未知不计为零）
    const status =
      knownCount > limit
        ? SEGMENT_STATUS.OVER
        : unknownProps.length > 0
          ? SEGMENT_STATUS.UNKNOWN
          : SEGMENT_STATUS.OK;
    if (knownCount > peakCount) peakCount = knownCount;
    segments.push({
      status,
      startMinute: fromMinute,
      endMinute: toMinute,
      knownCount,
      props: heldProps,
      unknownProps,
    });
  };

  // 起始分钟（含）以前的事件先归入起点状态
  let cursor = 0;
  while (cursor < eventMinutes.length && eventMinutes[cursor] <= startMinute) {
    for (const ev of eventsByMinute.get(eventMinutes[cursor])) applyEvent(ev);
    cursor += 1;
  }
  // 之后每个事件分钟即一个状态点：上一段止于该分钟，应用事件后自该分钟起新段
  let pointMinute = startMinute;
  while (cursor < eventMinutes.length) {
    const m = eventMinutes[cursor];
    if (m > endMinute) break; // 记录已按窗口过滤，正常不会越界
    emitSegment(pointMinute, m);
    for (const ev of eventsByMinute.get(m)) applyEvent(ev);
    pointMinute = m;
    cursor += 1;
  }
  emitSegment(pointMinute, endMinute + 1); // 末段延伸至窗口结束分钟之后

  const fmtRange = (s) => `第${s.startMinute}–${s.endMinute - 1}分钟`;

  // 超过上限的连续分钟段（确定超限；段内仍含未知道具时一并标注）
  const overSegments = segments
    .filter((s) => s.status === SEGMENT_STATUS.OVER)
    .map((s) => ({
      startMinute: s.startMinute,
      endMinute: s.endMinute,
      count: s.knownCount,
      props: s.props,
      unknownProps: s.unknownProps,
      note:
        `${fmtRange(s)}已知确定持有 ${s.knownCount} 件，超过上限 ${limit} 件` +
        (s.unknownProps.length
          ? `；另有 ${s.unknownProps.length} 件道具自冲突分钟起去向未知，实际持有可能更多`
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
      knownProps: s.props,
      unknownProps: s.unknownProps,
      note:
        `${fmtRange(s)}已知确定持有 ${s.knownCount} 件（未超过上限 ${limit} 件），但 ` +
        `${s.unknownProps.map((u) => `「${u.propName}」自第${u.conflictMinute}分钟冲突起`).join('、')}` +
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
