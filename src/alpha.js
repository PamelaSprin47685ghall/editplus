export function numToAlpha(n) {
  let result = ""
  while (n > 0) {
    n--
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

export function alphaToNum(s) {
  let result = 0
  for (const c of `${s}`.toUpperCase()) {
    result = result * 26 + (c.charCodeAt(0) - 64)
  }
  return result
}
