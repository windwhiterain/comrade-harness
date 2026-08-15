# HIL with No User Message：与 Agentic RL 对齐的人机协作协议

> 2026-08-17 · comrade-harness 项目 · 所有实证主张均标注 arXiv 编号，可检索核实

## 摘要

主流 Agentic RL 的 rollout 轨迹中不存在中途用户消息。本文论证两点：其一，对这一代与下一代模型，中途插入 user 修正消息构成可度量的风险，机制是通道—分布交互而非能力缺陷；其二，「人类参与修正、但用户消息不进入历史」的协议（HIL with no user message）在推理时通过保持轨迹处于训练分布内规避该风险，在训练时把每次人工修正转化为 step 级结构化监督信号。后者是其价值重心，且已有相邻系统的量化证据：同思路的采样框架带来 +28% 的训练收益。该协议首先是一个数据采集协议，其次才是交互协议。

---

## 1. 风险：训练分布中不存在的东西

Agentic RL 的 rollout 由「初始指令 + 模型自生成轨迹 + 环境观测」组装而成，中途没有用户轮；Agent-R1（2511.14460）把这一点显式化为可设计的 context construction rule。前沿模型进一步要求消息结构跨轮一致——Kimi K3（2607.24653）采用 preserved thinking，其设计理由原文是「使模型在跨轮时观察到一致的消息结构」。中途 user 消息是这两条事实共同定义的状态空间之外的输入形态。

出分布是有代价的，且已被量化：

- **多轮退化**：把同一任务的信息切分到多轮给出，15 个顶尖模型平均性能下降 39%，不可靠性上升 112%——能力基本保留，退化来自条件化失败（2505.06120）。
- **中途中断**：InterruptBench（2604.00892）在长程 web 任务中途注入用户更新，六个强模型出现 S→F 案例（原本能成功的任务被插话破坏）；典型失败模式是表面服从、不重整环境状态；DeepSeek-V3.1 在连续第 3 次更新时回退。
- **RL 不会自动修复，甚至恶化**：RLVR 奖励自信的直接回答，加剧多轮迷航（ICPO，2601.15330）；用户批评能把原本正确的解翻成错误解（ReCrit，2605.18799）。
- **理论证明**：多轮上下文的分布偏移按 O(H²) 平方级复合；只在静态完美历史上训练的模型缺乏纠错恢复技能，遇到真实用户中途指错即进入未训练状态、错误雪崩（2605.26403）。
- **逆缩放**：对上下文中「不该出现的指令状文本」的鲁棒性随模型增强而下降（DistractionIF，2605.29491）——更强的 agentic RL 模型对形态异常更敏感，而非相反。

但风险不在用户消息的内容，而在通道。同一修正以不同角色呈现，采纳率相差 23–93 个百分点（2606.05976）——修正效力是协议层可设计的变量，而非模型的固有属性。

## 2. 协议

一条会话轨迹中，唯一的人类消息是初始任务指令。中途修正以三种不破坏该不变式的方式实施：

- **V1 直接改写**：就地编辑 assistant 消息字段（reasoning / content / tool_calls），从改后历史继续；
- **V2 瞬态教练**：人类输入进入当次请求、模型据此重写自己的消息、瞬态文本随后丢弃；
- **V3 编辑即标注**：每次修正落结构化编辑日志（session / step / field / before / after）。

三个不变式：**I1** 初始指令唯一性（历史无中途 user 消息）；**I2** 严格标准消息形态（修正只做字段级替换）；**I3** 可审计性。

## 3. 价值一：推理时对齐 Agentic RL，规避风险

- 历史保持 agentic 形态、处于训练支持内（I1 + I2），直接规避 §1 的退化机制；
- 通道选择成为 harness 层的设计变量，而非模型分布的被动输出（2606.05976）；
- 人承担错误定位——模型最弱的环节：给定位后模型能改正，自己定位则不能（2311.08516）。

这部分价值的边界必须诚实说明：不改权重，任何通道都不能让模型「学会」修正；V1 还引入 off-policy 条件化（从非自生成推理继续）。DAgger 的教训是，这种干预的正确归宿是训练集而非推理时——这正是价值二的入口。

## 4. 价值二：更高质量的轨迹数据

Agentic RL 数据管线的瓶颈是公开的事实：RLVR 需要可验证奖励，而开放任务没有 verifier；agentic 轨迹的人工标注极其昂贵（2510.24701）。编辑日志直接供给三类稀缺信号：**step 级人类 oracle**（携带正确内容而非仅对错标量）、**before/after 偏好对**、**错误定位**。且修正后的轨迹天然是标准 rollout 形态，无需为训练额外清洗。

这个方向的价值已有直接量化：

- **Apollo**（2510.27630）：异步人工干预采样——人只在轨迹跑偏时给高级指引，且输入先入缓冲、「确保不干扰 agent 的推理过程」。以此训练 GLM-4.5，比无人工交互变体高 **28%**，比无干预基线高 50%。
- **OEC**（2512.14895）：学生开局、专家中途接管、**不插入任何新消息**（专家甚至不知前面是他人生成），SWE-bench Verified 上相对行为克隆 +14% / +13%。
- **供给侧缺口**：人类示范数据几乎不含「犯错→修正」序列，造成非推理模型平均 64.5% 的自我修正盲点；RL 推理模型恰因 outcome feedback 学会自我修正而无此盲点（2507.02778）。本协议的每次人工编辑天然产出这类序列——这是当前数据管线中最稀缺的原料。

## 5. 边界

两条反方证据值得记录。其一，user 通道是可训练的：把 user-simulator 轮放进训练分布，模型能学会中途跟随用户（2604.02869）；若行业普遍转向模拟器多轮训练，I1 的必要性下降。其二，推理时价值有天然上限（§3）。协议的稳健性不来自押对单一方向，而来自：方向 A（纯净轨迹）下它产出标准 rollout 与编辑日志，方向 B（用户模拟）下编辑日志可导出含修正对的对话数据；同时模拟器本身存在模式坍缩与 sim2real 差距（2608.12253、2605.26403），「无用户消息」对通用 agentic 模型在可预见的未来仍然成立。

## 结论

中途 user 插话对 agentic RL 模型的影响真实、可度量、且不随模型变强自动消失。把人工修正从「插话」改造为「改写」，协议在推理时买到通道控制权与分布内轨迹，在训练时把人在环协作转化为 step 级人类 oracle 数据——后者已被相邻系统验证有两位数收益。HIL with no user message 的定位因此清晰：它首先是一个数据采集协议，其次才是交互协议。

---

## 参考文献

1. Cheng et al. *Agent-R1: A Unified and Modular Framework for Agentic Reinforcement Learning*. arXiv:2511.14460.
2. Kimi Team. *Kimi K3: Open Frontier Intelligence*. arXiv:2607.24653.
3. Laban et al. *LLMs Get Lost In Multi-Turn Conversation*. arXiv:2505.06120.
4. Zou et al. *When Users Change Their Mind: Evaluating Interruptible Agents in Long-Horizon Web Navigation* (InterruptBench). arXiv:2604.00892.
5. *ICPO: Illocution-Calibrated Policy Optimization for Multi-Turn Conversation*. arXiv:2601.15330.
6. *ReCrit: Transition-Aware Reinforcement Learning for Scientific Critic Reasoning*. arXiv:2605.18799.
7. Wang et al. *From Static Context to Calibrated Interactive RL: Mitigating Distribution Shift in Multi-turn Dialogue with Aligned Simulator*. arXiv:2605.26403.
8. *The Curse of Helpfulness: Inverse Scaling Law in Robustness to Distractor Instructions via DistractionIF*. arXiv:2605.29491.
9. Chen et al. *The Self-Correction Illusion: Role Relabeling Gates Explicit Error Flagging in Large Language Models*. arXiv:2606.05976.
10. *LLMs cannot find reasoning errors, but can correct them given the error location*. arXiv:2311.08516.
11. Alibaba. *Tongyi DeepResearch Technical Report*. arXiv:2510.24701.
12. Fu et al. *Interaction as Intelligence Part II: Asynchronous Human-Agent Rollout for Long-Horizon Task Training* (Apollo). arXiv:2510.27630.
13. Lauffer et al. *Imitation Learning for Multi-turn LM Agents via On-policy Expert Corrections* (OEC). arXiv:2512.14895.
14. Tsui. *Self-Correction Bench: Uncovering and Addressing the Self-Correction Blind Spot in Large Language Models*. arXiv:2507.02778.
15. *Multi-Turn Reinforcement Learning for Tool-Calling Agents with Iterative Reward Calibration*. arXiv:2604.02869.
16. *One Frozen Simulator Is Not Enough: Simulator Collapse in Multi-Agent RL*. arXiv:2608.12253.
