#!/usr/bin/env bash
# Run the trusted rerun helper against deterministic GitHub API responses.
# These are behavior fixtures, not source-text assertions: they exercise the
# exact run, repository, and check binding used before the POST rerun call.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RERUN_SCRIPT="${ROOT_DIR}/.github/scripts/rerun-failed-cla.sh"
WORKFLOW="${ROOT_DIR}/.github/workflows/cla.yml"
[[ -f "${RERUN_SCRIPT}" && -f "${WORKFLOW}" ]] || exit 1
command -v jq >/dev/null
bash -n "${RERUN_SCRIPT}"

readonly REPO='manaflow-ai/cla-github-action'
readonly BASE_REF='master'
readonly HEAD_REF='feature/cla-rerun-fixture'
readonly HEAD_SHA='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly EXECUTION_SHA='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
readonly BASE_SHA='cccccccccccccccccccccccccccccccccccccccc'
readonly WORKFLOW_ID=300
readonly RUN_ID=400
readonly JOB_ID=500
readonly NEWER_RUN_ID=401
readonly NEWER_JOB_ID=501
readonly REPO_ID=100
readonly HEAD_REPO_ID=200
readonly PR_NUMBER=123
readonly COMMENT_ID=900
readonly COMMENT_TIME='2026-08-31T08:00:00Z'
readonly GENERATION='v2.2-action-212a0f2dd659b24b48a30ba35966e06dc41736af'

# The fake GitHub client runs in the helper's child shell. Export every
# fixture value it reads so `set -u` cannot turn a valid response into an API
# failure merely because a shell variable was not inherited.
export REPO BASE_REF HEAD_REF HEAD_SHA EXECUTION_SHA BASE_SHA WORKFLOW_ID RUN_ID JOB_ID NEWER_RUN_ID NEWER_JOB_ID REPO_ID HEAD_REPO_ID PR_NUMBER COMMENT_ID COMMENT_TIME GENERATION

export GH_REPO="${REPO}"
export EVENT_NAME=issue_comment
export ISSUE_NUMBER="${PR_NUMBER}"
export PR_NUMBER
export COMMENT_ID
export COMMENT_BODY=recheck
export COMMENT_CREATED_AT="${COMMENT_TIME}"
export COMMENT_AUTHOR_ID=300
export COMMENT_AUTHOR_LOGIN=contributor
export COMMENT_AUTHOR_TYPE=User
export COMMENT_AUTHOR_ASSOCIATION=NONE
export WORKFLOW_PATH=.github/workflows/cla.yml
WORKFLOW_SHA="$(git -C "${ROOT_DIR}" rev-parse HEAD)"
export WORKFLOW_SHA
export CLA_GENERATION="${GENERATION}"
export TARGET_EVENT=pull_request_target
export TARGET_BASE_REF="${BASE_REF}"
export SIGNATURE_RECORDED=false

gh() {
  local endpoint='' arg method=GET
  for arg in "$@"; do
    case "${arg}" in
      repos/*) endpoint="${arg}" ;;
      POST) method=POST ;;
    esac
  done
  [[ -n "${endpoint}" ]] || { echo 'missing API endpoint' >&2; return 1; }

  if [[ "${method}" == POST ]]; then
    printf '%s\n' "${endpoint}" >>"${FAKE_POST_FILE}"
    return 0
  fi

  local run_sha="${BASE_SHA}" run_repo_json
  if [[ "${FAKE_MODE}" == source-fallback ]]; then
    run_sha="${EXECUTION_SHA}"
  fi
  if [[ "${FAKE_MODE}" == null-source ]]; then
    run_repo_json=null
  else
    run_repo_json="{\"id\":${HEAD_REPO_ID},\"full_name\":\"contributor/cla-github-action\"}"
  fi

  case "${endpoint}" in
    "repos/${REPO}/issues/${PR_NUMBER}")
      jq -nc '{state:"open",pull_request:{url:("https://api.github.com/repos/" + $repo + "/pulls/" + ($number|tostring))}}' \
        --arg repo "${REPO}" --argjson number "${PR_NUMBER}"
      ;;
    "repos/${REPO}/issues/comments/${COMMENT_ID}")
      jq -nc --arg body "${COMMENT_BODY}" --arg time "${COMMENT_TIME}" \
        '{issue_url:("https://api.github.com/repos/" + $repo + "/issues/" + ($number|tostring)),body:$body,user:{id:300,login:"contributor",type:"User"},created_at:$time,updated_at:$time}' \
        --arg repo "${REPO}" --argjson number "${PR_NUMBER}"
      ;;
    "repos/${REPO}/pulls/${PR_NUMBER}")
      jq -nc --arg repo "${REPO}" --arg base "${BASE_REF}" --arg base_sha "${BASE_SHA}" \
        --arg head_ref "${HEAD_REF}" --arg head_sha "${HEAD_SHA}" \
        '{number:123,state:"open",user:{id:300,login:"contributor"},base:{ref:$base,sha:$base_sha,repo:{id:100,full_name:$repo}},head:{ref:$head_ref,sha:$head_sha,repo:{id:200,full_name:"contributor/cla-github-action"}}}'
      ;;
    "repos/${REPO}/commits/${HEAD_SHA}/pulls")
      printf '[]\n'
      ;;
    "repos/${REPO}/pulls")
      jq -nc --arg repo "${REPO}" --arg base "${BASE_REF}" --arg base_sha "${BASE_SHA}" \
        --arg head_ref "${HEAD_REF}" --arg head_sha "${HEAD_SHA}" \
        '[{number:123,state:"open",base:{ref:$base,sha:$base_sha,repo:{id:100,full_name:$repo}},head:{ref:$head_ref,sha:$head_sha,repo:{id:200,full_name:"contributor/cla-github-action"}}}]'
      ;;
    "repos/${REPO}/actions/workflows")
      jq -nc --arg path "${WORKFLOW_PATH}" '{workflows:[{id:300,path:$path,state:"active"}]}'
      ;;
    "repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs")
      if [[ "${FAKE_MODE}" == newer-run-wins ]]; then
        jq -nc --arg path "${WORKFLOW_PATH}" --arg name 'CLA Assistant v3' \
          --arg base "${BASE_REF}" --arg base_sha "${BASE_SHA}" \
          --arg head_ref "${HEAD_REF}" --arg head_sha "${HEAD_SHA}" \
          --arg execution_sha "${EXECUTION_SHA}" --argjson run_repo "${run_repo_json}" \
          --argjson older_id "${RUN_ID}" --argjson newer_id "${NEWER_RUN_ID}" \
          '{workflow_runs:[
            {id:$older_id,workflow_id:300,name:$name,path:$path,event:"pull_request_target",status:"completed",conclusion:"failure",head_sha:$head_sha,head_branch:$head_ref,head_repository:$run_repo,
             pull_requests:[{number:123,state:"open",base:{ref:$base,sha:$base_sha,repo:{id:100,full_name:"manaflow-ai/cla-github-action"}},head:{ref:$head_ref,sha:$head_sha,repo:{id:200,full_name:"contributor/cla-github-action"}}}],created_at:"2026-08-31T07:00:00Z"},
            {id:$newer_id,workflow_id:300,name:$name,path:$path,event:"pull_request_target",status:"completed",conclusion:"failure",head_sha:$base_sha,head_branch:$head_ref,head_repository:$run_repo,pull_requests:[],created_at:"2026-08-31T07:30:00Z"}
          ]}'
        return 0
      fi
      jq -nc --arg path "${WORKFLOW_PATH}" --arg name 'CLA Assistant v3' \
        --arg run_sha "${run_sha}" --argjson run_repo "${run_repo_json}" \
        '{workflow_runs:[{id:400,workflow_id:300,name:$name,path:$path,event:"pull_request_target",status:"completed",conclusion:"failure",head_sha:$run_sha,head_branch:$head_ref,head_repository:$run_repo,pull_requests:[],created_at:"2026-08-31T07:00:00Z"}]}' \
        --arg head_ref "${HEAD_REF}"
      ;;
    "repos/${REPO}/actions/runs/${RUN_ID}"|"repos/${REPO}/actions/runs/${NEWER_RUN_ID}")
      local response_run_id="${RUN_ID}" response_run_sha="${run_sha}" response_created='2026-08-31T07:00:00Z' response_pull_requests='[]'
      if [[ "${FAKE_MODE}" == newer-run-wins ]]; then
        if [[ "${endpoint}" == "repos/${REPO}/actions/runs/${NEWER_RUN_ID}" ]]; then
          response_run_id="${NEWER_RUN_ID}"
          response_run_sha="${BASE_SHA}"
          response_created='2026-08-31T07:30:00Z'
        else
          response_run_sha="${HEAD_SHA}"
          response_pull_requests="[{\"number\":123,\"state\":\"open\",\"base\":{\"ref\":\"${BASE_REF}\",\"sha\":\"${BASE_SHA}\",\"repo\":{\"id\":100,\"full_name\":\"${REPO}\"}},\"head\":{\"ref\":\"${HEAD_REF}\",\"sha\":\"${HEAD_SHA}\",\"repo\":{\"id\":200,\"full_name\":\"contributor/cla-github-action\"}}}]"
        fi
      fi
      jq -nc --arg path "${WORKFLOW_PATH}" --arg name 'CLA Assistant v3' \
        --argjson run_id "${response_run_id}" --arg run_sha "${response_run_sha}" \
        --argjson run_repo "${run_repo_json}" --arg head_ref "${HEAD_REF}" \
        --arg created "${response_created}" --argjson pull_requests "${response_pull_requests}" \
        '{id:$run_id,workflow_id:300,name:$name,path:$path,event:"pull_request_target",status:"completed",conclusion:"failure",head_sha:$run_sha,head_branch:$head_ref,head_repository:$run_repo,pull_requests:$pull_requests,created_at:$created}'
      ;;
    "repos/${REPO}/actions/runs/${RUN_ID}/jobs"|"repos/${REPO}/actions/runs/${NEWER_RUN_ID}/jobs")
      local response_run_id="${RUN_ID}" response_job_id="${JOB_ID}" response_run_sha="${run_sha}"
      if [[ "${FAKE_MODE}" == newer-run-wins && "${endpoint}" == "repos/${REPO}/actions/runs/${NEWER_RUN_ID}/jobs" ]]; then
        response_run_id="${NEWER_RUN_ID}"
        response_job_id="${NEWER_JOB_ID}"
        response_run_sha="${BASE_SHA}"
      fi
      jq -nc --argjson run_id "${response_run_id}" --argjson job_id "${response_job_id}" \
        --arg run_sha "${response_run_sha}" --arg generation "${GENERATION}" \
        '{jobs:[{id:$job_id,run_id:$run_id,name:"CLA Assistant v3",status:"completed",conclusion:"failure",head_sha:$run_sha,steps:[{name:("CLA generation " + $generation),status:"completed",conclusion:"failure"}]}]}'
      ;;
    "repos/${REPO}/actions/jobs/${JOB_ID}"|"repos/${REPO}/actions/jobs/${NEWER_JOB_ID}")
      local response_run_id="${RUN_ID}" response_job_id="${JOB_ID}" response_run_sha="${run_sha}"
      if [[ "${FAKE_MODE}" == newer-run-wins && "${endpoint}" == "repos/${REPO}/actions/jobs/${NEWER_JOB_ID}" ]]; then
        response_run_id="${NEWER_RUN_ID}"
        response_job_id="${NEWER_JOB_ID}"
        response_run_sha="${BASE_SHA}"
      fi
      jq -nc --argjson run_id "${response_run_id}" --argjson job_id "${response_job_id}" \
        --arg run_sha "${response_run_sha}" --arg generation "${GENERATION}" \
        '{id:$job_id,run_id:$run_id,name:"CLA Assistant v3",status:"completed",conclusion:"failure",head_sha:$run_sha,steps:[{name:("CLA generation " + $generation),status:"completed",conclusion:"failure"}]}'
      ;;
    "repos/${REPO}/commits/${HEAD_SHA}/check-runs"|"repos/${REPO}/commits/${BASE_SHA}/check-runs")
      local check_sha="${endpoint#repos/"${REPO}"/commits/}"
      check_sha="${check_sha%/check-runs}"
      local expected_sha="${BASE_SHA}" expected_run_id="${RUN_ID}" expected_job_id="${JOB_ID}"
      if [[ "${FAKE_MODE}" == source-fallback ]]; then
        expected_sha="${HEAD_SHA}"
      elif [[ "${FAKE_MODE}" == newer-run-wins && "${check_sha}" == "${BASE_SHA}" ]]; then
        expected_sha="${BASE_SHA}"
        expected_run_id="${NEWER_RUN_ID}"
        expected_job_id="${NEWER_JOB_ID}"
      elif [[ "${FAKE_MODE}" == newer-run-wins && "${check_sha}" == "${HEAD_SHA}" ]]; then
        expected_sha="${HEAD_SHA}"
      fi
      if [[ "${check_sha}" != "${expected_sha}" ]]; then
        printf '{"check_runs":[]}\n'
      else
        jq -nc --arg sha "${check_sha}" --argjson run_id "${expected_run_id}" --argjson job_id "${expected_job_id}" \
          --arg repo "${REPO}" \
          '{check_runs:[{id:9000,name:"CLA Assistant v3",status:"completed",conclusion:"failure",head_sha:$sha,app:{id:15368,slug:"github-actions"},details_url:("https://github.com/" + $repo + "/actions/runs/" + ($run_id|tostring) + "/job/" + ($job_id|tostring))}]}'
      fi
      ;;
    *)
      echo "unexpected API endpoint: ${endpoint}" >&2
      return 1
      ;;
  esac
}
export -f gh

run_case() {
  local mode="$1" expected_status="$2" expected_text="$3" expected_post="$4"
  local output status posts
  : >"${FAKE_POST_FILE}"
  set +e
  output="$(FAKE_MODE="${mode}" FAKE_POST_FILE="${FAKE_POST_FILE}" FAKE_LOG_FILE="${FAKE_LOG_FILE}" bash "${RERUN_SCRIPT}" 2>&1)"
  status=$?
  set -e
  [[ "${status}" == "${expected_status}" ]] || {
    echo "${mode}: expected status ${expected_status}, got ${status}" >&2
    echo "${output}" >&2
    exit 1
  }
  [[ "${output}" == *"${expected_text}"* ]] || {
    echo "${mode}: missing expected output '${expected_text}'" >&2
    echo "${output}" >&2
    exit 1
  }
  posts="$(wc -l <"${FAKE_POST_FILE}" | tr -d '[:space:]')"
  if [[ -n "${expected_post}" ]]; then
    if [[ "${posts}" != 1 ]] || ! grep -Fxq "${expected_post}" "${FAKE_POST_FILE}"; then
      echo "${mode}: expected one POST to ${expected_post}, got ${posts}" >&2
      cat "${FAKE_POST_FILE}" >&2
      exit 1
    fi
  else
    [[ "${posts}" == 0 ]] || { echo "${mode}: unexpected rerun POST" >&2; exit 1; }
  fi
  echo "PASS: ${mode}"
}

FAKE_POST_FILE="$(mktemp)"
FAKE_LOG_FILE="$(mktemp)"
trap 'rm -f "${FAKE_POST_FILE}" "${FAKE_LOG_FILE}"' EXIT
run_case normal-empty 0 "Requested rerun for CLA job 500" "repos/${REPO}/actions/jobs/${JOB_ID}/rerun"
run_case source-fallback 0 "Requested rerun for CLA job 500" "repos/${REPO}/actions/jobs/${JOB_ID}/rerun"
run_case newer-run-wins 0 "Requested rerun for CLA job 501" "repos/${REPO}/actions/jobs/${NEWER_JOB_ID}/rerun"
run_case null-source 1 "no pull request association with complete source metadata" ''
