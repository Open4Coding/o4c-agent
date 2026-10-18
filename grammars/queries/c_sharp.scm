(class_declaration
 name: (identifier) @name.definition.class
 ) @definition.class

(class_declaration
   (base_list (_) @name.reference.class)
 ) @reference.class

(interface_declaration
 name: (identifier) @name.definition.interface
 ) @definition.interface

(interface_declaration
 (base_list (_) @name.reference.interface)
 ) @reference.interface

(method_declaration
 name: (identifier) @name.definition.method
 ) @definition.method

(object_creation_expression
 type: (identifier) @name.reference.class
 ) @reference.class

; [version-skew, disabled] (type_parameter_constraints_clause
; [version-skew, disabled]  target: (identifier) @name.reference.class
; [version-skew, disabled]  ) @reference.class

; [version-skew, disabled] (type_constraint
; [version-skew, disabled]  type: (identifier) @name.reference.class
; [version-skew, disabled]  ) @reference.class

(variable_declaration
 type: (identifier) @name.reference.class
 ) @reference.class

(invocation_expression
 function:
  (member_access_expression
    name: (identifier) @name.reference.send
 )
) @reference.send

(namespace_declaration
 name: (identifier) @name.definition.module
) @definition.module

; Direct invocations, added 2026-10-18. The published query captures only
; member-access calls (`obj.Method()`), so a plain `Foo(x)` produced no reference
; at all - which is most intra-class calls in C#.
(invocation_expression
  function: (identifier) @name.reference.call) @reference.call
