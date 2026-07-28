/* Harness for loop_linearity_no_break.fit. The loop never exits, so this counts
   close_conn calls and exits once the repeat is established rather than hanging.
   Buggy behaviour (expected today): CLOSE 1..3 then REPEATED_FREE.
   Correct behaviour, once the checker rejects this shape: the program never
   compiles, and this harness becomes unnecessary. */

#include <stdio.h>
#include <stdlib.h>

typedef struct { int fd; } Conn;
void leak_loop(void);

Conn open_conn(void) { Conn c; c.fd = 7; return c; }

static int closes = 0;
void close_conn(Conn c) {
    printf("CLOSE %d fd=%d\n", ++closes, c.fd);
    if (closes >= 3) { printf("REPEATED_FREE\n"); exit(0); }
}

int main(void) { leak_loop(); printf("RETURNED\n"); return 0; }
