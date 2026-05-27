/* cleanup_scope_stubs.c — stubs for cleanup_scope.fit */
#include <stdio.h>
#include <string.h>

/*
 * Widget is defined by the generated C translation unit.
 * We declare it here again as a compatible typedef for this TU.
 */
typedef struct { int id; } Widget;

extern int run(void); /* defined in generated .c */

/* Observable cleanup log: each cleanup fn appends its name */
static char cleanup_log[256] = "";

/* Extern implementations */
Widget make_widget(void) {
    Widget w = {42};
    return w;
}

void free_widget(Widget w) {
    (void)w;
    strcat(cleanup_log, "free_widget ");
}

int main(void) {
    run();

    /* Expected: free_widget fires once at scope exit */
    if (strcmp(cleanup_log, "free_widget ") == 0) {
        printf("PASS cleanup_scope: free_widget fired at scope exit\n");
        return 0;
    } else {
        printf("FAIL cleanup_scope: got '%s', expected 'free_widget '\n", cleanup_log);
        return 1;
    }
}
