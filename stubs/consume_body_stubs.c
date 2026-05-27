/* consume_body_stubs.c — stubs for consume_body.fit
 *
 * This is a real compiler-verified test. The close_conn(c) call inside finish()
 * is emitted by codegen — not chosen by this stub. The stub provides close_conn's
 * implementation (appending to cleanup_log) and asserts it fires exactly once.
 */
#include <stdio.h>
#include <string.h>

/* Types match codegen output exactly */
typedef struct { int fd; } Conn;
extern void close_conn(Conn v); /* defined below */
extern int run(void);           /* defined in generated .c */

static char cleanup_log[256] = "";

Conn make_conn(void) {
    Conn c = {1};
    return c;
}

/* summarize lends c — does not consume it, does not trigger cleanup */
int summarize(Conn c) {
    (void)c;
    return 0;
}

void close_conn(Conn c) {
    (void)c;
    strcat(cleanup_log, "close_conn ");
}

int main(void) {
    run();

    /* close_conn fires inside finish() at scope exit — compiler-emitted, not stub-chosen.
       finish() received c by move, held it through the body (summarize only lends),
       and the compiler inserted close_conn(c) before return. */
    if (strcmp(cleanup_log, "close_conn ") == 0) {
        printf("PASS consume_body: close_conn fired once inside finish (compiler-emitted)\n");
        return 0;
    } else {
        printf("FAIL consume_body: got '%s', expected 'close_conn '\n", cleanup_log);
        return 1;
    }
}
