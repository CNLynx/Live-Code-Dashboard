// Waits for an answer file: prints its contents and removes it as soon as it
// appears, or exits silently after the given seconds. The mod runs it while a
// question waits for the dashboard, the Stream Deck or the band's buttons: a
// hook's own time is bounded, the time a process it awaits takes is not.
//
//   node wait-answer.mjs <answer file> <seconds>
import fs from 'node:fs'

const [file, seconds = '20'] = process.argv.slice(2)
const until = Date.now() + Math.max(1, Math.min(120, Number(seconds) || 20)) * 1000

const look = () => {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (text.trim() === '') return false
    JSON.parse(text)
    fs.rmSync(file, { force: true })
    process.stdout.write(text)
    return true
  } catch {
    // not there yet, or mid-write: look again
    return false
  }
}

const timer = setInterval(() => {
  if (look() || Date.now() > until) {
    clearInterval(timer)
    process.exit(0)
  }
}, 150)
look() && process.exit(0)
