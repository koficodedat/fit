/* Harness for loop_linearity_param_no_break.fit. The loop never exits, so this
   counts close_conn calls and exits once the repeat is established rather than
   hanging.
   Predicted (buggy): CLOSE 1..3 then REPEATED_FREE.
   Correct, once the checker rejects consuming inside an unbounded loop: the
   program does not compile and this harness becomes unnecessary. */

#include <stdio.h>
#include <stdlib.h>

typedef struct { int fd; } Conn;
void leak_loop_param(Conn c);

static int closes = 0;
void close_conn(Conn c) {
    printf("CLOSE %d fd=%d\n", ++closes, c.fd);
    if (closes >= 3) { printf("REPEATED_FREE\n"); exit(0); }
}

int main(void) {
    Conn c; c.fd = 7;
    leak_loop_param(c);
    printf("RETURNED\n");
    return 0;
}
