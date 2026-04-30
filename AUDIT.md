# Audit

## Per-file 互斥锁

`handleEdit` 在 `prepareEdit`（读文件）之前获取 per-file 锁，把「读 → 校验 → 写 → 更新 registry」整个临界区串行化，防止 TOCTOU 竞争导致静默覆盖。

锁实现为 `Map<string, Promise>` 门卫队列，同一文件的第二个调用等待第一个完成后再读最新内容。不同文件不阻塞。

## End sentinel 流水号

`read` 和 `grep` 分配 N+1 个流水号，最后一个映射到 line=N（文件末尾），显示为空行：

```
1|line1
2|line2
3|line3
4|
```

这解决了：
- **编辑最后一行** — `{begin: 3, endExclusive: 4}` 替换末行
- **追加** — `{begin: sentinel, endExclusive: sentinel}` 纯插入在末尾
- **空文件编辑** — 空文件返回 `1|`，`{begin:1, endExclusive:1}` 插入首行

## begin == endExclusive 纯插入

`validateEditParams` 原用 `<=` 禁止相等。改为 `<` 后，不同读的同线流水号可做纯插入（不替换内容）。

## 剩余约定

- **`formatSerialLines` 无边界守卫** — 仅 handlers.js 内部调用，调用者保证 `serials.length === lines.length`。设计约定，不加固。
- **Registry 段累积** — 每次 read 增加 N+1 个段，旧段不清理。resolve 反向扫描找最新段，正确性不受影响。
