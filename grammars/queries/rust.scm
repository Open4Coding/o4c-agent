; ADT definitions

(struct_item
    name: (type_identifier) @name.definition.class) @definition.class

(enum_item
    name: (type_identifier) @name.definition.class) @definition.class

(union_item
    name: (type_identifier) @name.definition.class) @definition.class

; type aliases

(type_item
    name: (type_identifier) @name.definition.class) @definition.class

; method definitions - a fn in an impl or trait body. One kind per fn: the earlier pattern
; captured every fn as a function as well, so a method defined once was two candidates, and a
; free fn inside `mod tests { }` (also a declaration_list) was filed as a method.

(impl_item
    body: (declaration_list
        (function_item
            name: (identifier) @name.definition.method) @definition.method))

(trait_item
    body: (declaration_list
        (function_item
            name: (identifier) @name.definition.method) @definition.method))

; function definitions - at the top level, in a mod, or nested in a block

(source_file
    (function_item
        name: (identifier) @name.definition.function) @definition.function)

(mod_item
    body: (declaration_list
        (function_item
            name: (identifier) @name.definition.function) @definition.function))

(block
    (function_item
        name: (identifier) @name.definition.function) @definition.function)

; trait definitions
(trait_item
    name: (type_identifier) @name.definition.interface) @definition.interface

; module definitions
(mod_item
    name: (identifier) @name.definition.module) @definition.module

; macro definitions

(macro_definition
    name: (identifier) @name.definition.macro) @definition.macro

; references

(call_expression
    function: (identifier) @name.reference.call) @reference.call

; `x.f()` is captured as a method call: Rust has no implicit self, so it can only reach a method,
; and a bare `f()` can never reach one. A closure in a field is called as `(x.f)()`.
(call_expression
    function: (field_expression
        field: (field_identifier) @name.reference.method)) @reference.call

; `m!()` is its own kind: it can only reach a `macro_rules!`, never a function or method of the
; same name - `assert!` was resolving to a JavaScript `function assert`, `env!` to an `fn env`.
(macro_invocation
    macro: (identifier) @name.reference.macro) @reference.call

; implementations

(impl_item
    trait: (type_identifier) @name.reference.implementation) @reference.implementation

(impl_item
    type: (type_identifier) @name.reference.implementation
    !trait) @reference.implementation
