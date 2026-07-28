/* Harness for loop_linearity_drop_break.fit.
   Buggy behaviour (expected today): CLOSE, DONE, CLOSE — two cleanups for one
   resource. Correct behaviour, once the loop-exit live set is propagated:
   CLOSE, DONE — one cleanup. */

#include <stdio.h>

typedef struct { int fd; } Conn;
void double_cleanup(void);

Conn open_conn(void) { Conn c; c.fd = 7; return c; }
void close_conn(Conn c) { printf("CLOSE fd=%d\n", c.fd); }
void done(void) { printf("DONE\n"); }

int main(void) { double_cleanup(); return 0; }
