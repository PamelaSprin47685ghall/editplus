import * as realIO from "./io.js"
import { handleRead } from "./read-handler.js"
import { handleEdit } from "./edit-handler.js"
import { handleGrep } from "./grep-handler.js"

export const createHandlers = (deps = {}) => {
  const st = { io: deps.io ?? realIO, expand: deps.expandGlob ?? realIO.expandGlob, inspect: deps.inspectPath ?? realIO.inspectPath }
  return { read: p => handleRead(st, p), edit: p => handleEdit(st, p), grep: p => handleGrep(st, p) }
}

export { handleRead, handleEdit, handleGrep }
