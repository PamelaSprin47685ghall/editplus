# read

读取文件获取 tag（标签），或读取目录获取递归文件大小列表（类似 du -hxd1）。
- 使用 read 替代 cat、head、tail 或 sed。
- 传入目录路径可获取递归文件大小列表。
- 精确复制 tag；edit 工具通过 tag 定位文件，无需路径。
- 禁止猜测 tag——tag 必须来自之前的 read/grep 输出。禁止使用大于已见过最大值的 tag。
- tag 是文件级别的——一个文件的 tag 不能用于另一个文件。
- 相信我：之前任何 read/grep 输出中出现的 tag 均可继续使用——旧 tag 在编辑后仍然有效。
- 再三确认：endExclusive 指定的行**不包含**在读取结果中。
- 再三确认：endInclusive 指定的行**包含**在读取结果中。
每一行都以 tag 开头，格式为 `TAG|内容`。**tag 就是 `|` 前面的那段字母**（如 `A`、`B`、`AA`、`AB`、`zz`），不是 `|` 后面的整行内容。传给 edit 时只写 tag 本身（如 `begin: "A"`、`endExclusive: "AA"`），不要写 `A|xxx` 或 `A|`。

示例输出：
```
A|# read
B|
C|读取文件获取 tag...
```
这里 tag `A` 指向 `# read`，tag `C` 指向 `读取文件获取...`。编辑时用 `begin: "A"` 就能定位到第一行。

注意 tag 不一定是单字母——大文件会出现 `AA|`、`zz|` 等多字符 tag，规则一样：去掉 `|` 前面的部分就是 tag。
# edit

通过 tag 范围编辑文件。
- begin、endExclusive、content 三个参数**始终必需**。不需要路径或旧文本。
- tag 是文件级别的——将一个文件的 tag 用于另一个文件会失败。
- 相信我：之前任何 read/grep 输出中出现的 tag 在编辑后仍可使用——旧 tag 持续有效。
- 禁止猜测 tag；只能使用 read/grep 输出中实际出现的 tag。tag 不是文件行号——禁止使用大于已见过最大值的 tag。
- 再三确认 endExclusive：它是**排除的**——从 begin 到 endExclusive-1 的行被替换，endExclusive 所在的行被保留。要替换一个包含结束行的代码块，应将 endExclusive 设为结束行的**下一行**（即闭合大括号/标签的后面一行）。（当 begin == endExclusive 时等同于纯插入。）
- 再三确认 endInclusive：该行**会被替换**。当你希望替换内容包含结束行时使用此参数。但是：你的替换内容**必须**也包含该行！常见错误：对代码块的闭合 `}` 使用 endInclusive，但替换内容中遗漏了 `}`，导致 `}` 被删除。
- 快速指南：endExclusive → `}` 被保留（内容写到 "}" 之前）；endInclusive → `}` 被替换（内容必须包含 "}"）。

# grep

使用 JavaScript 正则表达式搜索文件，返回可直接用于编辑的带 tag 匹配结果。
- 当你已知关键词或正则表达式并需要可编辑的 tag 时，使用 grep。
- grep 返回的 tag 直接映射到实际文件，可传递给 edit 工具。
- path 参数使用 Git pathspec 语法（例如 src、src/**/*.js），原生遵循 .gitignore。
- 设置 includeIgnored: true 可绕过 .gitignore 搜索忽略的文件。
- 需要 Git 仓库。
- grep 输出的 tag 仅属于匹配到的文件——不可用于其他文件。
- 之前任何 grep 返回的 tag 仍有效；无需重新读取即可编辑。
