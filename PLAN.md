# Serial 管理优化方案

## 核心思想

维持不变性：**每行总有 serial**。第一次 read/grep 分配后，后续不再重复分配，全部复用已有映射。

## 数据结构

每个文件独立维护：

```
fileState[y] = {
  segs: [{ x, z }, ...],     // 数据本体，可追加
  byX:  [ idx0, ... ],       // segs 索引，按 x 升序（new serial 自然 append）
  byZ:  [ idx0, ... ],       // segs 索引，按 z 升序
}
```

段无显式 `count`。范围由 `byX`/`byZ` 中下一个条目隐含决定，末尾用 sentinel 做边界。

## 查找

**serialForLine(L)**：扫描 `byZ`，指针自然前进。read/grep 输出时需计算 serial：

```
let j = 0
for line index L in 0..lineCount:
  while nextZ(byZ[j]) <= L: j++
  serial = segs[byZ[j]].x + (L - segs[byZ[j]].z)
```

指针 j 单调递增，全程线性 O(n)。

**resolve(S)**：扫描 `byX`，到 `x > S` 为止：

```
for each idx in byX:
  if segs[idx].x > S:
    prevSeg = segs[priorIdx]
    return prevSeg.z + (S - prevSeg.x)
```

## 编辑

替换 `[lo, hi)` 为 n 行，`delta = n - (hi - lo)`，**一趟线性扫描 `byZ`** 同步完成：

```
newByZ = []

for each idx in byZ:
  seg = segs[idx]

  BEFORE: 范围在 lo 之前
    if seg.z + count <= lo:
      append idx to newByZ
      continue

  REPLACING: 范围与 [lo, hi) 重叠
    seg.z < lo < seg.z + count  → split at lo
      左段 [z, lo)      → append, 状态不变
      右段 [lo, end)    → 入队，继续

    lo ≤ seg.z < hi:
      seg.z + count ≤ hi  → skip
      seg.z < hi < seg.z + count  → split at hi
        左段 [z, hi)  skip
        右段 [hi, end)  z += delta, append
        队列新段 assign, append, 进入 AFTER
      seg.z ≥ hi  → assign 新段 append, seg.z += delta append, 进入 AFTER

  AFTER: 范围在 hi 之后
    z += delta, append
```

旁路：

- **`assign`**：新段 `{ x: nextSerial, z: lo }`，`nextSerial += n`，`segs.push()`，`byX.push(newIdx)`
- **跳过段**：被替换段保留在 `segs` 中但不出现在新 `byZ` 和 `byX` 中（从 byX 中 filter 掉或标记删除）
- **移位段**：z 在原位修改，byX 指向同一对象，自动同步

## 访问接口

```
class LineRegistry:
  #nextSerial
  #states: Map<path, FileState>
  #sentinel: Sentinel

  assign(path, line, count)    → 分配新 serials
  serialForLine(path, line)    → 查 serial，read/grep 用
  resolve(serial)              → { path, line }，edit 用
  edit(path, lo, hi, n)        → 替换，one pass
  hasFile(path)                → 是否已有该文件状态
  removeFile(path)             → 清空（外部修改时）
```
