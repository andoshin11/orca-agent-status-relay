// Orca plugin worker entry: forwards agent status changes to the configured URL.
import { defaultConfigPath } from './src/config.mjs'
import { createRelay } from './src/relay.mjs'

export default function activate(orca) {
  const relay = createRelay({
    configPath: defaultConfigPath(),
    log: (line) => orca.log(line)
  })

  // Returns without awaiting delivery: Orca waits for each handler before
  // acknowledging the event, and kills workers that fall behind.
  orca.events.on('agent.status.changed', (payload) => {
    relay.handleStatus(payload)
  })

  orca.commands.register('agent-status-relay.send-test', () => relay.sendTest())
}
