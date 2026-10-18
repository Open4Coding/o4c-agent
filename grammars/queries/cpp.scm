(struct_specifier name: (type_identifier) @name.definition.class body:(_)) @definition.class

(declaration type: (union_specifier name: (type_identifier) @name.definition.class)) @definition.class

(function_declarator declarator: (identifier) @name.definition.function) @definition.function

(function_declarator declarator: (field_identifier) @name.definition.function) @definition.function

(function_declarator declarator: (qualified_identifier scope: (namespace_identifier) @local.scope name: (identifier) @name.definition.method)) @definition.method

(type_definition declarator: (type_identifier) @name.definition.type) @definition.type

(enum_specifier name: (type_identifier) @name.definition.type) @definition.type

(class_specifier name: (type_identifier) @name.definition.class) @definition.class

; Call references, authored 2026-10-18. aider's cpp-tags.scm captures 8 definition
; patterns and no references. C++ needs a third form the C query does not:
; qualified_identifier, for ns::fn() and Class::method() call sites.
; The macro hole from c.scm applies here too.
(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (qualified_identifier
    name: (identifier) @name.reference.call)) @reference.call

(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)) @reference.call
