(class_declaration
  name: (name) @name.definition.class) @definition.class

(function_definition
  name: (name) @name.definition.function) @definition.function

(method_declaration
  name: (name) @name.definition.function) @definition.function

(object_creation_expression
  [
    (qualified_name (name) @name.reference.class)
    (variable_name (name) @name.reference.class)
  ]) @reference.class

(function_call_expression
  function: [
    (qualified_name (name) @name.reference.call)
    (variable_name (name)) @name.reference.call
  ]) @reference.call

(scoped_call_expression
  name: (name) @name.reference.call) @reference.call

(member_call_expression
  name: (name) @name.reference.call) @reference.call

; Unqualified function calls, added 2026-10-18. The published pattern expects the
; `function` field to be a `qualified_name`, but in this grammar version a bare
; `square($x)` call carries a plain `(name)` there - so every unqualified function
; call, which is most PHP calls, produced no reference at all.
(function_call_expression
  function: (name) @name.reference.call) @reference.call
