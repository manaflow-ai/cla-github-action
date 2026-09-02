import * as core from '@actions/core'
import { ApiResult } from './errors'

/** Publish the action's stable result contract for trusted downstream jobs. */
export function setApiResult(result: ApiResult): void {
  core.setOutput('api_result', result)
}
