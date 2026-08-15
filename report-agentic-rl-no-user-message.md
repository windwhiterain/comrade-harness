# Human-in-loop with No User

当前主流的 Agentic 强化学习训练中，rollout 轨迹普遍只包含一条初始用户指令，其后全部是模型自生成的推理、工具调用与环境观测，中途没有用户消息插入。虽然也出现了模拟用户消息的一些方法，但 sim2real gap 仍然存在。

结合近期 deepseek v4 “过拟合” harness 的情况，
