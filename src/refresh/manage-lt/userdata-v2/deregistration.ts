/* eslint-disable no-useless-escape */
import { WorkerSignalOperations } from '../../../services/dynamodb/operations/signal-operations.js'

// Available:
// LOOP_RUN_PID
// LOOP_ID

export function tokenlessDeregistration(): string {
  const functionName = 'tokenlessDeregistration'
  const script = `
# Function to peform tokenless deregistration
${functionName}() {
  echo "PERFORMING TOKENLESS DEREGISTRATION..."
  if [ -f .runner ]; then
    echo "Found .runner removing..."
    rm .runner
  else
    echo "no .runner found. following tokenless ./config.sh remove may fail..."
  fi

  echo "Calling config.sh remove"
  if ./config.sh remove; then
    echo "Successfully removed registration files, emitting signal..."
    emitSignal "$LOOP_ID" "${WorkerSignalOperations.OK_STATUS.UD_REMOVE_REG}"
  else
    echo "Unsuccessfully removed registration files, emitting signal..."
    emitSignal "$LOOP_ID" "${WorkerSignalOperations.FAILED_STATUS.UD_REMOVE_REG}"
    exit 1
  fi

  # Shutdown run on tokenless deregistration
  # 1. Check runner is still alive
  if kill -0 "$LOOP_RUN_PID" 2>/dev/null; then
    echo "Runner ($LOOP_RUN_PID) still alive, looking for Runner.Listener…"
  
    # 2. Capture listener PID if it exists
    listener_info=$(pgrep -f Runner.Listener)
    if [[ -n $listener_info ]]; then
      _runner_listener_pid=$\{listener_info%% *\}
      echo "Found Runner.Listener ($_runner_listener_pid), shutting down both…"
      sudo kill -TERM "$_runner_listener_pid" "$LOOP_RUN_PID"
    else
      echo "Runner.Listener not running, shutting down Runner only…"
      sudo kill -TERM "$LOOP_RUN_PID"
    fi
  
    # 3. Optionally wait for clean exit
    wait "$LOOP_RUN_PID"
  else
    echo "The runner process has already exited ($LOOP_RUN_PID)"
  fi
}
`

  return script.trim()
}

export function properDeregistration(): string {
  const functionName = 'properDeregistration'

  const script = `
# Function to peform proper deregistration
${functionName}() {
  echo "PERFORMING PROPER DEREGISTRATION..."

  echo "Performing config.sh remove..."
  _gh_reg_token=$(fetchGHToken)
  if ./config.sh remove --token "$_gh_reg_token"; then
    echo "Successfully removed registration files, emitting signal..."
    emitSignal "$LOOP_ID" "${WorkerSignalOperations.OK_STATUS.UD_REMOVE_REG}"
  else
    echo "Unsuccessfully removed registration files, emitting signal..."
    emitSignal "$LOOP_ID" "${WorkerSignalOperations.FAILED_STATUS.UD_REMOVE_REG}"
    exit 1
  fi

  echo "Shutting down run.sh and child processes..."
  if kill -0 $LOOP_RUN_PID; then
    echo "Runner ($LOOP_RUN_PID) still alive, sending kill signal and now awaiting..."
    sudo kill -TERM $LOOP_RUN_PID 
    wait $LOOP_RUN_PID
  else
    echo "The runner process has already been removed ($LOOP_RUN_PID)"
  fi 
}`

  return script.trim()
}
