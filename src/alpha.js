export function numToAlpha(n) {
  let result = ""
  while (n > 0) {
    n--
    const offset = n % 52
    result = String.fromCharCode(offset < 26 ? 65 + offset : 97 + offset - 26) + result
    n = Math.floor(n / 52)
  }
  return result
}

export function alphaToNum(s) {
  let result = 0
  for (const c of s) {
    const code = c.charCodeAt(0)
    if (code >= 65 && code <= 90) result = result * 52 + code - 64
    else if (code >= 97 && code <= 122) result = result * 52 + code - 96 + 26
  }
  return result
}
