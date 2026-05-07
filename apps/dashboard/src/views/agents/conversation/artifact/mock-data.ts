import type { Spec } from '@json-render/core'
import { buildSpec, node } from './spec-builder'

/**
 * Mock data + spec generators for 4 canned business questions.
 * The mock-tool layer detects keywords in the user message and returns
 * the matching artifact + a one-paragraph natural-language answer.
 *
 * All numbers here are fictional but proportionally realistic for a
 * mid-sized 1-on-1 tutoring business in China (Q3 2025).
 */

export type ArtifactKind = 'revenue' | 'refund' | 'unconsumed' | 'staff'

export interface ArtifactBundle {
  /** Stable identifier so the workspace pane can dedupe / select. */
  id: string
  kind: ArtifactKind
  title: string
  /** Quick subtitle shown in the chat tool-call summary. */
  summary: string
  /** Markdown answer attached to the artifact in chat. */
  narrative: string
  spec: Spec
  /** Hint to the conversation about which follow-up prompts to surface next. */
  followups: string[]
}

const REVENUE_BY_MONTH = [
  { x: '7月', y: 4_120_000, refund: 246_000 },
  { x: '8月', y: 4_385_000, refund: 312_000 },
  { x: '9月', y: 4_335_000, refund: 354_000 },
]

const TOTAL_REVENUE = REVENUE_BY_MONTH.reduce((s, r) => s + r.y, 0)
const TOTAL_REFUND = REVENUE_BY_MONTH.reduce((s, r) => s + r.refund, 0)
const REFUND_RATE = TOTAL_REFUND / TOTAL_REVENUE
const UNCONSUMED_HOURS = 18_420 // 累计未消课时

/* -------------------------------------------------------------------------- */
/*  Revenue overview                                                          */
/* -------------------------------------------------------------------------- */

function buildRevenueSpec(): Spec {
  return buildSpec(
    node('Frame', {
      title: '家教业务 · 季度概览',
      subtitle: '营收与退款的整体走势，三大核心指标已完成与 Q2 的环比。',
      period: 'Q3 2025',
    }, [
      node('Stack', { direction: 'vertical', gap: 5 }, [
        node('Stack', { direction: 'horizontal', gap: 3 }, [
          node('Metric', {
            label: '总营收',
            value: TOTAL_REVENUE,
            format: 'currency',
            caption: '环比 Q2 +6.4%',
            delta: 0.064,
            trend: 'up',
          }),
          node('Metric', {
            label: '退款总额',
            value: TOTAL_REFUND,
            format: 'currency',
            caption: '环比 Q2 +18.2%',
            delta: 0.182,
            trend: 'up',
            invertTrend: true,
          }),
          node('Metric', {
            label: '退款率',
            value: REFUND_RATE,
            format: 'percent',
            caption: '上限红线 6.0%',
            delta: 0.011,
            trend: 'up',
            invertTrend: true,
          }),
          node('Metric', {
            label: '未消课时',
            value: UNCONSUMED_HOURS,
            format: 'duration_h',
            caption: '负债约 ¥4.2M',
            delta: 0.082,
            trend: 'up',
            invertTrend: true,
          }),
        ]),
        node('Heading', { text: '月度营收 vs 退款', level: 'h3' }),
        node('LineChart', {
          area: true,
          height: 240,
          yFormat: 'currency',
          series: [
            {
              name: '营收',
              color: 'accent',
              format: 'currency',
              points: REVENUE_BY_MONTH.map((m) => ({ x: m.x, y: m.y })),
            },
            {
              name: '退款',
              color: 'rose',
              format: 'currency',
              points: REVENUE_BY_MONTH.map((m) => ({ x: m.x, y: m.refund })),
            },
          ],
        }),
        node(
          'Callout',
          { tone: 'warn', title: '需要关注', icon: 'warn' },
          [
            node('Text', {
              text: '9 月退款继续抬升至 ¥354 K（占当月营收 8.2%），主要来自高年级 1v1 退课。建议深挖退款原因。',
            }),
          ],
        ),
      ]),
    ]),
  )
}

/* -------------------------------------------------------------------------- */
/*  Refund deep-dive                                                          */
/* -------------------------------------------------------------------------- */

function buildRefundSpec(): Spec {
  return buildSpec(
    node('Frame', {
      title: '退款深度解读',
      subtitle: '按原因分布与高退款率班次，定位结构性问题。',
      period: 'Q3 2025',
    }, [
      node('Stack', { direction: 'vertical', gap: 5 }, [
        node('Stack', { direction: 'horizontal', gap: 3, wrap: true }, [
          node('Metric', {
            label: '退款笔数',
            value: 1_284,
            caption: '环比 Q2 +21%',
            delta: 0.21,
            trend: 'up',
            invertTrend: true,
          }),
          node('Metric', {
            label: '平均退款金额',
            value: 7_098,
            format: 'currency',
            caption: '人均 1.6 课包',
            delta: -0.024,
            trend: 'down',
            invertTrend: true,
          }),
          node('Metric', {
            label: '退款响应时长',
            value: 28,
            format: 'duration_h',
            caption: 'SLA 48h',
            delta: -0.32,
            trend: 'down',
          }),
        ]),
        node('Heading', { text: '退款原因分布', level: 'h3' }),
        node('BarChart', {
          horizontal: true,
          height: 220,
          yFormat: 'currency',
          series: [
            {
              name: '退款金额',
              color: 'rose',
              format: 'currency',
              points: [
                { x: '老师匹配不满意', y: 412_000 },
                { x: '孩子时间冲突',     y: 296_000 },
                { x: '效果未达预期',     y: 184_000 },
                { x: '价格 / 性价比',    y: 142_000 },
                { x: '客服体验问题',     y: 78_000 },
              ],
            },
          ],
        }),
        node('Heading', { text: '高退款率班次（前 5）', level: 'h3' }),
        node('DataTable', {
          highlightOutliers: { key: 'refundRate', high: 0.12, low: null },
          columns: [
            { header: '课程', key: 'name', align: 'start' },
            { header: '在读学员', key: 'students', align: 'end', format: 'number' },
            { header: '营收', key: 'revenue', align: 'end', format: 'currency' },
            { header: '退款率', key: 'refundRate', align: 'end', format: 'percent' },
            { header: '主要原因', key: 'reason', align: 'start' },
          ],
          rows: [
            { name: '高三冲刺 · 1v1', students: 248, revenue: 1_640_000, refundRate: 0.142, reason: '老师匹配' },
            { name: '初三压轴 · 1v1', students: 192, revenue: 1_120_000, refundRate: 0.128, reason: '老师匹配' },
            { name: '高二托管 · 1v3', students: 312, revenue: 980_000,   refundRate: 0.094, reason: '时间冲突' },
            { name: '初二语文 · 1v1', students: 158, revenue: 720_000,   refundRate: 0.082, reason: '效果' },
            { name: '高一数学 · 1v1', students: 204, revenue: 840_000,   refundRate: 0.061, reason: '老师匹配' },
          ],
        }),
        node(
          'Callout',
          { tone: 'bad', title: '结构性问题', icon: 'warn' },
          [
            node('Text', {
              text: '老师匹配不满意贡献了 36% 的退款金额，且高度集中在高三/初三 1v1 课程。考虑在这两条线引入"试听免责退"+"双师替换"机制。',
            }),
          ],
        ),
      ]),
    ]),
  )
}

/* -------------------------------------------------------------------------- */
/*  Unconsumed lessons                                                        */
/* -------------------------------------------------------------------------- */

function buildUnconsumedSpec(): Spec {
  return buildSpec(
    node('Frame', {
      title: '未消课时风险',
      subtitle: '存量课包结构与到期分布，对应负债 ≈ ¥4.2M。',
      period: '截至 2025-10-31',
    }, [
      node('Stack', { direction: 'vertical', gap: 5 }, [
        node('Stack', { direction: 'horizontal', gap: 3, wrap: true }, [
          node('Metric', {
            label: '未消课时合计',
            value: UNCONSUMED_HOURS,
            format: 'duration_h',
            caption: '约 ¥4.2M 负债',
          }),
          node('Metric', {
            label: '在册有效学员',
            value: 5_280,
            caption: '人均 3.5 h',
          }),
          node('Metric', {
            label: '6 个月内到期',
            value: 7_920,
            format: 'duration_h',
            caption: '占比 43%',
            delta: 0.18,
            trend: 'up',
            invertTrend: true,
          }),
        ]),
        node('Heading', { text: '按课程分组', level: 'h3' }),
        node('BarChart', {
          height: 240,
          yFormat: 'duration_h',
          stacked: true,
          series: [
            {
              name: '6 个月内到期',
              color: 'rose',
              format: 'duration_h',
              points: [
                { x: '高三 1v1', y: 1_840 },
                { x: '高二 1v1', y: 1_120 },
                { x: '初三 1v1', y: 1_960 },
                { x: '初二 1v1', y: 980 },
                { x: '托管 1v3', y: 1_320 },
                { x: '其他',     y: 700 },
              ],
            },
            {
              name: '6 个月以上',
              color: 'teal',
              format: 'duration_h',
              points: [
                { x: '高三 1v1', y: 1_240 },
                { x: '高二 1v1', y: 1_560 },
                { x: '初三 1v1', y: 1_080 },
                { x: '初二 1v1', y: 2_240 },
                { x: '托管 1v3', y: 1_840 },
                { x: '其他',     y: 2_540 },
              ],
            },
          ],
        }),
        node('Heading', { text: '占比最高的 6 个班次', level: 'h3' }),
        node('DataTable', {
          highlightOutliers: { key: 'monthsLeft', high: null, low: 6 },
          columns: [
            { header: '班次', key: 'name', align: 'start' },
            { header: '未消课时', key: 'hours', align: 'end', format: 'duration_h' },
            { header: '负债', key: 'debt', align: 'end', format: 'currency' },
            { header: '平均剩余', key: 'monthsLeft', align: 'end', format: 'number' },
          ],
          rows: [
            { name: '高三 1v1 · 海淀',     hours: 1_240, debt: 286_000, monthsLeft: 4 },
            { name: '初三 1v1 · 朝阳',     hours: 1_080, debt: 248_000, monthsLeft: 5 },
            { name: '高二 1v1 · 西城',     hours: 920,   debt: 215_000, monthsLeft: 6 },
            { name: '高三 1v1 · 朝阳',     hours: 880,   debt: 210_000, monthsLeft: 5 },
            { name: '初二 1v1 · 海淀',     hours: 760,   debt: 168_000, monthsLeft: 8 },
            { name: '托管 1v3 · 跨区',     hours: 720,   debt: 148_000, monthsLeft: 10 },
          ],
        }),
        node(
          'Callout',
          { tone: 'warn', title: '建议', icon: 'spark' },
          [
            node('Text', {
              text: '高三/初三毕业季结束后 4–6 个月剩余的课包是退款主战场。可推"应届升级套餐"，引导转课至次年新班次以降低集中退款。',
            }),
          ],
        ),
      ]),
    ]),
  )
}

/* -------------------------------------------------------------------------- */
/*  Staff KPI                                                                 */
/* -------------------------------------------------------------------------- */

function buildStaffSpec(): Spec {
  return buildSpec(
    node('Frame', {
      title: '家教 KPI · 季度排行',
      subtitle: '按业绩、续费、退款三个维度对老师/班主任进行评估。',
      period: 'Q3 2025',
    }, [
      node('Stack', { direction: 'vertical', gap: 5 }, [
        node('Stack', { direction: 'horizontal', gap: 3, wrap: true }, [
          node('Metric', {
            label: '在岗教师',
            value: 248,
            caption: '同比 +12',
            delta: 0.051,
            trend: 'up',
          }),
          node('Metric', {
            label: '人均季度营收',
            value: 51_800,
            format: 'currency',
            caption: '环比 Q2 +3.1%',
            delta: 0.031,
            trend: 'up',
          }),
          node('Metric', {
            label: '续费率',
            value: 0.682,
            format: 'percent',
            caption: '目标 70%',
            delta: -0.018,
            trend: 'down',
            invertTrend: true,
          }),
        ]),
        node('Heading', { text: 'TOP 教师与待改善人员', level: 'h3' }),
        node('DataTable', {
          highlightOutliers: { key: 'refundRate', high: 0.12, low: null },
          columns: [
            { header: '教师', key: 'name', align: 'start' },
            { header: '学科', key: 'subject', align: 'start' },
            { header: '在读', key: 'students', align: 'end', format: 'number' },
            { header: '季度营收', key: 'revenue', align: 'end', format: 'currency' },
            { header: '续费率', key: 'renew', align: 'end', format: 'percent' },
            { header: '退款率', key: 'refundRate', align: 'end', format: 'percent' },
          ],
          rows: [
            { name: '王 海',  subject: '高中数学', students: 38, revenue: 184_000, renew: 0.82, refundRate: 0.024 },
            { name: '李 晴',  subject: '初中语文', students: 36, revenue: 162_000, renew: 0.79, refundRate: 0.031 },
            { name: '张 默',  subject: '高中英语', students: 32, revenue: 148_000, renew: 0.74, refundRate: 0.042 },
            { name: '赵 朗',  subject: '高中物理', students: 28, revenue: 132_000, renew: 0.71, refundRate: 0.058 },
            { name: '孙 行',  subject: '初中数学', students: 32, revenue: 138_000, renew: 0.66, refundRate: 0.092 },
            { name: '周 牧',  subject: '高中数学', students: 22, revenue: 84_000,  renew: 0.45, refundRate: 0.142 },
            { name: '陈 越',  subject: '初中英语', students: 18, revenue: 68_000,  renew: 0.41, refundRate: 0.158 },
          ],
        }),
        node('Heading', { text: '续费 vs 退款 · 教师维度', level: 'h3' }),
        node('BarChart', {
          height: 240,
          yFormat: 'percent',
          series: [
            {
              name: '续费率',
              color: 'accent',
              format: 'percent',
              points: [
                { x: '王 海', y: 0.82 },
                { x: '李 晴', y: 0.79 },
                { x: '张 默', y: 0.74 },
                { x: '赵 朗', y: 0.71 },
                { x: '孙 行', y: 0.66 },
                { x: '周 牧', y: 0.45 },
                { x: '陈 越', y: 0.41 },
              ],
            },
            {
              name: '退款率',
              color: 'rose',
              format: 'percent',
              points: [
                { x: '王 海', y: 0.024 },
                { x: '李 晴', y: 0.031 },
                { x: '张 默', y: 0.042 },
                { x: '赵 朗', y: 0.058 },
                { x: '孙 行', y: 0.092 },
                { x: '周 牧', y: 0.142 },
                { x: '陈 越', y: 0.158 },
              ],
            },
          ],
        }),
        node(
          'Callout',
          { tone: 'accent', title: '建议', icon: 'spark' },
          [
            node('Text', {
              text: '周牧、陈越两位教师退款率超过 14% 且续费率不足 50%，建议进入"成长辅导池"——配双师陪跑 6 周，期间不分配高单价 1v1。',
            }),
          ],
        ),
      ]),
    ]),
  )
}

/* -------------------------------------------------------------------------- */
/*  Bundle catalog                                                            */
/* -------------------------------------------------------------------------- */

export const ARTIFACTS: Record<ArtifactKind, ArtifactBundle> = {
  revenue: {
    id: 'revenue-q3',
    kind: 'revenue',
    title: 'Q3 营收概览',
    summary: '总营收 ¥12.84M、退款 ¥912K、退款率 7.1%、未消课时 18,420h。',
    narrative:
      '**Q3 总营收 ¥12.84M（环比 +6.4%）**，但退款同步攀升至 ¥912K，**退款率 7.1% 已突破 6% 红线**。' +
      '\n\n9 月退款单月 ¥354K，趋势向上，主要压力在高年级 1v1 课程。未消课时累积到 1.84 万小时，' +
      '对应资金负债约 ¥4.2M。**建议下一步：先看退款的结构原因，再决定是降负债还是提续费。**',
    spec: buildRevenueSpec(),
    followups: ['退款的主要原因是什么？', '哪些班次未消课时风险最高？'],
  },
  refund: {
    id: 'refund-q3',
    kind: 'refund',
    title: '退款深度解读',
    summary: '36% 退款来自老师匹配不满意；高三/初三 1v1 退款率 ≥ 12.8%。',
    narrative:
      '**老师匹配不满意是单一最大原因**（贡献 ¥412K，占退款金额 36%），且高度集中在' +
      '高三冲刺 1v1（14.2%）和初三压轴 1v1（12.8%）。' +
      '\n\n时间冲突排第二（¥296K，主要在 1v3 托管）。客服体验问题占比最低，但响应 SLA 已收紧到 28h，' +
      '继续投资于这一项的边际收益不大。\n\n**建议下一步：复盘高/初三 1v1 老师的匹配流程，' +
      '考虑试听免责退 + 双师替换；同时排查这些班次的教师 KPI。**',
    spec: buildRefundSpec(),
    followups: ['高退款率的老师有谁？', '未消课时主要集中在哪些班？'],
  },
  unconsumed: {
    id: 'unconsumed-q3',
    kind: 'unconsumed',
    title: '未消课时风险',
    summary: '未消 18,420h ≈ ¥4.2M 负债；6 个月内到期占 43% 且 +18%。',
    narrative:
      '**未消课时累积 18,420 小时**，对应资金负债约 ¥4.2M。**6 个月内到期占 43%（+18% 环比）**，' +
      '集中度极高的是高三/初三 1v1 班次。\n\n毕业季后 4-6 个月剩余的课包是退款主战场，' +
      '海淀高三 1v1、朝阳初三 1v1 是最大单点风险。\n\n**建议下一步：' +
      '上线"应届升级套餐"，引导毕业季学员转课至次年新班次，配合早提醒 + 老师挽留。**',
    spec: buildUnconsumedSpec(),
    followups: ['这些班次是哪些教师？', '员工绩效如何？'],
  },
  staff: {
    id: 'staff-q3',
    kind: 'staff',
    title: '员工绩效',
    summary: '续费率 68.2%（差目标 1.8pt）；2 位教师退款率 ≥ 14%。',
    narrative:
      '**248 位在岗教师，人均季度营收 ¥51.8K**（环比 +3.1%）；但**续费率回落到 68.2%，' +
      '低于 70% 目标 1.8pt**。\n\n头部 5 位教师续费率均超 70%、退款率 < 6%，可作为标杆。' +
      '尾部周牧、陈越退款率 ≥ 14%，续费率 < 50%，明显失衡，是 Q4 改善重点。' +
      '\n\n**建议下一步：把尾部 2 位教师纳入"成长辅导池"——配双师陪跑 6 周，' +
      '不分配高单价 1v1；同时把 TOP 5 教师的匹配画像反向喂给新生分配算法。**',
    spec: buildStaffSpec(),
    followups: ['基于以上数据，Q4 业务调整建议？', '退款率高的老师所在班级表现如何？'],
  },
}
