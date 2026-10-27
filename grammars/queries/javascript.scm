(
  (comment)* @doc
  .
  (method_definition
    name: (property_identifier) @name.definition.method) @definition.method
  (#not-eq? @name.definition.method "constructor")
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.method)
)

(
  (comment)* @doc
  .
  [
    (class
      name: (_) @name.definition.class)
    (class_declaration
      name: (_) @name.definition.class)
  ] @definition.class
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.class)
)

(
  (comment)* @doc
  .
  [
    (function_expression
      name: (identifier) @name.definition.function)
    (function_declaration
      name: (identifier) @name.definition.function)
    (generator_function
      name: (identifier) @name.definition.function)
    (generator_function_declaration
      name: (identifier) @name.definition.function)
  ] @definition.function
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name.definition.function
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (variable_declaration
    (variable_declarator
      name: (identifier) @name.definition.function
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(assignment_expression
  left: (identifier) @name.definition.function
  right: [(arrow_function) (function_expression)]
) @definition.function

; A function stored in a property - `obj.f = () => {}`, `{ f: () => {} }` - is a `field`, not a
; `function`: it is called as `obj.f()`, which `resolve.ts` does not let reach a `function`, or
; bare after destructuring. Filed as `function` (until 2026-10-27), every `api.fetchUser()` on a
; handler object was declined. See the kinds note in `typescript.scm`.
(assignment_expression
  left: (member_expression
    property: (property_identifier) @name.definition.field)
  right: [(arrow_function) (function_expression)]
) @definition.field

(pair
  key: (property_identifier) @name.definition.field
  value: [(arrow_function) (function_expression)]) @definition.field

(
  (call_expression
    function: (identifier) @name.reference.call) @reference.call
  (#not-match? @name.reference.call "^(require)$")
)

; A member call is captured as `name.reference.method`, not `name.reference.call`, so that
; resolution can tell `f()` from `o.f()`. Nothing is invented by this: Java's own tag query
; already emits `name.reference.method` for an invocation, which is why `edgeKind.ts` counts
; `method` as a call kind - the edge kind is unchanged and only the stored `kind` differs.
;
; Added 2026-10-22 from the acceptance measurement. The largest group of both remaining misses
; and remaining wrong answers was `receiver.method()`, and the index held no record of which
; shape a reference had, so nothing downstream could prefer a method for one and a function for
; the other.
(call_expression
  function: (member_expression
    property: (property_identifier) @name.reference.method)
  arguments: (_) @reference.call)

(new_expression
  constructor: (_) @name.reference.class) @reference.class
