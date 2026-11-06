<img src="https://raw.githubusercontent.com/yiyiSmallti/diptych/main/market/icon.svg" width="64" alt="双联画图标">

# @precinct/diptych

dsh 插件：dsh web 右侧栏里的火与冰双人解谜平台游戏「双联画」。你用键盘控一个角色，会话里的 Agent 控另一个；30 关分五章，手绘风格的角色、机关和每章一张背景；按钮、拉杆、闸门、升降台、浮桥、踏板，每关都得配合。纯 JS、零依赖，原版 dsh 装上即可玩。

- 在会话的右侧边栏引导页点「双联画」，选角色和关卡，开始后点「叫 Agent 来玩」。
- Agent 工具：`diptych_look`（带坐标的文字地图）、`diptych_act`（自动驾驶走、跳、拉拉杆、说话）、`diptych_wait`（等你）。
- 游戏里打字、右键打标记，Agent 都能收到。

![dsh web 里的双联画](https://raw.githubusercontent.com/yiyiSmallti/diptych/main/docs/images/overview.jpg)

安装：`dsh plugin --profile web add @precinct/diptych`，或在 dsh web 侧栏「插件」→「添加插件」输入包名。

源码与测试见 [GitHub 仓库](https://github.com/yiyiSmallti/diptych)。
