import { main } from './index'

main(process.argv.slice(2), {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  env: process.env,
}).then((code) => {
  process.exitCode = code
})
