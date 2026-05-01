# byX 排序挑战

## 背景

editplus 是一个基于序列号（serial）的文件编辑系统。每个文件在被读取时，每一行都获得一个全局唯一的递增序列号。后续的编辑操作通过序列号来引用行，而不是行号或文件路径。

序列号系统的核心组件是 `LineRegistry`（`src/registry.js`），它维护每个文件的多组段（segments）。每个段记录一个连续的序列号范围和对应的行号范围：

```
{ x: serialStart, z: lineStart }
```

`byX` 是按序列号（x）排序的段索引数组。`resolve(serial)` 方法通过扫描 `byX` 来找到序列号对应的段，然后算出行号。
`byX` 是按序列号（x）排序的段索引数组。`resolve(serial)` 方法通过扫描 `byX` 来找到序列号对应的段，然后算出行号。

`byZ` 是按行号（z）排序的段索引数组（与 byX 共享同一组段）。`serialForLine(line)` 扫描 byZ 找到行对应的段，算出其序列号。

### 前戏：为什么 byZ 天然有序

每次编辑的 `edit()` 方法在重建 byZ 时采用：

```js
state.byZ = [
  ...left.map(s => s.idx),   // 编辑范围之前的段（z < lo）
  ...mid.map(s => s.idx),    // 本次编辑新插入的段（z = lo）
  ...right.map(s => s.idx),  // 编辑范围之后的段（z ≥ hi）
  SENTINEL,
]
```

**z 序天然成立**的原因：

1. `left` 的 z 全部 < lo（由 `seg.z + count ≤ lo` 条件保证）
2. `mid` 的 z 精确等于 lo（由 `newSeg.z = lo` 保证）
3. `right` 的 z 全部 ≥ hi（由 `seg.z ≥ hi` 条件保证），且 hi > lo 严格成立

所以 z 序恒为：`left.z < mid.z < right.z`。**byZ 不需要排序。**

这一结论与段的数量或编辑次数无关——每次编辑都把这个不变量维护得很好。

### 对比：为什么 byX 不行

byX 在 `edit()` 中自前次编辑的段结构重建。byX 需要的是 x 序（序列号），但收集段时沿用的是 byZ 的 z 序遍历。问题出在这里：

每次编辑中 `right` 段的 x 等于 `原 x + dropCount`（中等），而 `mid` 段的 x 来自全局计数器 `#nextSerial`（最大）。在 z 序中 `mid` 排在 `right` 之前，但 x 值 `mid.x > right.x`。当后续编辑把所有段收集到 left 时：

```
byZ (z序): [prev_left, prev_mid, prev_right]   ← 遍历顺序
x 值:       [small,     LARGE,    medium ]      ← mid 在 right 之前
byX 需要:   [small,     medium,   LARGE ]       ← mid 应在 right 之后
```

这就是 byX 需要显式 `.sort()` 的原因。
## 问题

```js
// edit() 函数中 byX 的构建
state.byX = [
  ...left.map(s => s.idx),   // 编辑范围之前的段
  ...right.map(s => s.idx),  // 编辑范围之后的段
  ...mid.map(s => s.idx),    // 本次编辑新插入的行
]
```

这段代码假设 `[left, right, mid]` 天然按 x 有序。这个假设在**单次编辑**时成立，但在**多次编辑积累后**失效。

### 为什么失效

每次编辑会分裂段。被编辑范围覆盖的段会被分成：

- left 部分：保留原始 x（最小）
- right 部分：x = 原 x + dropCount（中等）
- mid 部分：全新序列号，来自全局计数器（最大）

在 z 序（行号顺序）中，段排列为：`[prev_left, prev_mid, prev_right]`。但在 x 序中：`[prev_left, prev_right, prev_mid]`。注意 mid 的 x 最大，但在 z 序中它排在中间。

当下一次编辑把所有段都归入 `left` 时（即新编辑范围在所有段之后），left 按 z 序收集为 `[prev_left, prev_mid, prev_right]`，x 值为 `[小, 大, 中]`。

`byX = [left, right, mid]` 此时变为 `[prev_left(x=小), prev_mid(x=大), prev_right(x=中)]` — **未排序**！

```
byZ (z序): prev_left | prev_mid | prev_right
x 值:       small       LARGE      medium
byX 需要:   small       medium     LARGE
```

### 后果

`resolve(serial)` 线性扫描 `byX` 来定位段。当 `byX` 未排序时，它会找到错误的段，算出错误的行号，然后误判序列号为 stale（过期），拒绝合法编辑请求。

## 修复

```js
state.byX = [
  ...left.map(s => s.idx),
  ...right.map(s => s.idx),
  ...mid.map(s => s.idx),
].sort((a, b) => state.segs[a].x - state.segs[b].x)
```

显式的 `.sort()` 保证 x 序不变式。

## 挑战题目

### 难度：★★★★☆

你被要求**不要使用 .sort()，用一次遍历（one-pass）重建 byX 并保证 x 序**。

### 约束

1. 在一次 byZ 遍历中完成所有段的分类和排序
2. 不能使用全局排序（`.sort()`、`Array.prototype.sort()`、或任何等价操作）
3. 不能引入新的存储结构（如平衡树、优先队列）
4. 必须正确处理所有段的状态：
   - 全在编辑前（wholly before）→ 保留原索引
   - 全在编辑后（wholly after）→ 创建新副本，z 偏移
   - 跨越编辑范围（split）→ left 部分保留原索引，right 部分创建新段
   - 插入行（mid）→ 创建新段，最高 x

### 核心难点

`byZ` 的遍历顺序是 z 序（行号），但 `byX` 需要 x 序（序列号）。在一次遍历中同时维护两个序，需要理解**z 序和 x 序在编辑后的分歧规律**。

以下性质可能帮助你思考：

1. `mid.x > right.x > left.x` 永远成立（mid 拿到的是 `#nextSerial`，大于所有已存在的序列号）
2. mid 段不能被后续编辑分裂（因为它只覆盖插入的若干行，后续编辑要么在其前、要么在其后、要么覆盖删除它）
3. `byZ = [prev_left, prev_mid, prev_right]` 的结构在每次编辑后都会保持

### 考察要点

- 对段分裂 / 合并的理解
- 对多个有序序（z、x、mid/non-mid）的分析能力
- 在遍历中建立多个不变量并维护它们的能力
- 权衡：为什么最终选择了 `.sort()` 而不是 one-pass？

### 参考文件

- `src/registry.js` — `LineRegistry` 类
- `src/registry.js` 的 `edit()` 方法
- 猴子测试记录见 HINTS.md 和 commit a262a75

## 附加发现：serialForLine 的 x 边界校验

修复 byX 排序后还发现了一个二次问题：

`serialForLine(path, line)` 通过 byZ 找到段，再用 `seg.x + (line - seg.z)` 算序列号。但 mid 段（x 高，z 低）会切断后续 right 段（x 低，z 高）的 x 范围——right 段算出的序列号可能落入 mid 段的领地。

```js
seg[6]: { x:11, z:6 }     ← right 段，x 低，z 高
seg[7]: { x:104, z:2 }    ← mid 段，x 高（#nextSerial），z 低
serialForLine(line=99): byZ 找到 seg[6], 11+(99-6)=104
                        但 104 是 seg[7] 的起始序列号！
```

### 修复

算出 serial 后扫描 byX 找到真正的 x 归属段，如果与 z 段不一致则用 x 段的公式重算：

```js
let xIdx = -1
for (const idx of state.byX) {
  if (state.segs[idx].x > serial) break
  xIdx = idx
}
if (xIdx !== -1 && xIdx !== state.byZ[zIdx]) {
  const xSeg = state.segs[xIdx]
  return xSeg.x + (line - xSeg.z)
}
```

这个校验加上 byX.sort() 之后，所有范围内行都能正确 resolve。

### 边界 case：mid 段被删除后 x 范围失控

当 mid 段因后续编辑被完全删除（wholly within edit range），其 x 边界也随之消失。剩余段的 x 范围变为无界，`serialForLine` 对超出行文件长度的行会算出不存在的序列号。在实际使用中 `serialForLine` 不会被调用给不存在的行，因此这不是运行时问题，但对正确性推理有启发。
