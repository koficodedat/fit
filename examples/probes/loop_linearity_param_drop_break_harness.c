/* Harness for loop_linearity_param_drop_break.fit.
   Predicted (buggy): CLOSE, DONE, CLOSE — two cleanups for one resource.
   Correct, once the loop-exit live set is propagated: CLOSE, DONE. */

#include <stdio.h>

typedef struct { int fd; } Conn;
void double_cleanup_param(Conn c);

static int closes = 0;
void close_conn(Conn c) { printf("CLOSE %d fd=%d\n", ++closes, c.fd); }
void done(void) { printf("DONE\n"); }

int main(void) {
    Conn c; c.fd = 7;
    double_cleanup_param(c);
    printf("TOTAL=%d\n", closes);
    return 0;
}
