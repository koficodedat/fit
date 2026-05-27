#!/usr/bin/env bash
# spike.sh — FIT codegen spike: emit C, compile, run, verify cleanup behavior

cd "$(dirname "$0")/.."

FIT="npx ts-node src/main.ts"
CC="${CC:-cc}"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
PASS=0
FAIL=0

run_program() {
    local name="$1"
    local fit_file="$2"
    local stubs_file="$3"

    echo "--- $name ---"

    # Step 1: emit C from FIT source
    if ! $FIT codegen "$fit_file" > "$TMP/${name}.c"; then
        echo "  FAIL: codegen error"
        FAIL=$((FAIL + 1))
        echo ""
        return
    fi

    # Step 2: compile generated C + stubs
    if ! $CC "$TMP/${name}.c" "$stubs_file" -o "$TMP/${name}" -std=c11 -Wall -Wno-unused-value; then
        echo "  FAIL: compile error"
        FAIL=$((FAIL + 1))
        echo ""
        return
    fi

    # Step 3: run and report
    if "$TMP/${name}"; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
    echo ""
}

run_program "cleanup_scope" "tests/cleanup_scope.fit" "stubs/cleanup_scope_stubs.c"
run_program "cleanup_drop"  "tests/cleanup_drop.fit"  "stubs/cleanup_drop_stubs.c"
run_program "cleanup_error" "tests/cleanup_error.fit" "stubs/cleanup_error_stubs.c"
run_program "payment"       "tests/payment.fit"       "stubs/payment_stubs.c"
run_program "consume_body"  "tests/consume_body.fit"  "stubs/consume_body_stubs.c"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
