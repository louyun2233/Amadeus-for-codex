import { loadCharacterContent } from './character.mjs'

/** Default content is source-controlled and can be replaced per character. */
export const TASK_LINES = Object.freeze(loadCharacterContent('kurisu').taskLines)

/** Draw every line once before reshuffling; never repeat at a cycle boundary. */
export class TaskLinePicker {
  constructor(random = Math.random, lines = TASK_LINES) {
    this.random = random
    this.lines = lines
    this.bags = new Map()
    this.last = new Map()
  }

  next(kind) {
    const lines = this.lines[kind]
    if (!lines?.length) return null
    let bag = this.bags.get(kind)
    if (!bag?.length) {
      bag = Array.from({ length: lines.length }, (_, index) => index)
      for (let i = bag.length - 1; i > 0; i--) {
        const value = Number(this.random())
        const j = Number.isFinite(value) ? Math.min(i, Math.max(0, Math.floor(value * (i + 1)))) : 0
        ;[bag[i], bag[j]] = [bag[j], bag[i]]
      }
      if (bag.length > 1 && bag.at(-1) === this.last.get(kind)) {
        ;[bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]]
      }
      this.bags.set(kind, bag)
    }
    const index = bag.pop()
    this.last.set(kind, index)
    return lines[index]
  }
}

export const taskLinePicker = new TaskLinePicker()
