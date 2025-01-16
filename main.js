// Import modules from node_modules and your local dist directory
import { EditorView, basicSetup } from 'codemirror';
import { python } from './dist/index.js'; // Adjust the path if necessary

// Initialize the editor
const view = new EditorView({
  parent: document.getElementById('editor'),
  doc: `print("Hello world")\nmatch x:`,
  extensions: [basicSetup, python()]
});
