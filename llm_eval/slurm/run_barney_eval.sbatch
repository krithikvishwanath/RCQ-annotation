#!/usr/bin/env bash
#SBATCH --job-name=rcq-barney
#SBATCH --partition=cpu_short
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --time=02:00:00
#SBATCH --output=outputs/slurm-%j.log

set -euo pipefail

eval_root="${SLURM_SUBMIT_DIR}"
if [[ ! -f "${eval_root}/pyproject.toml" ]]; then
  echo "Submit this job from the repository's llm_eval directory." >&2
  exit 2
fi
cd "${eval_root}"
source .venv/bin/activate

# One process owns all bounded async concurrency. Do not wrap this in an array.
rcq-llm-eval "$@"
