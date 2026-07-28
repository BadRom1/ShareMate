import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Pas de `globals: true` dans la config : le nettoyage automatique de Testing Library n'est pas
// enregistré, chaque rendu resterait dans le document pour le test suivant.
afterEach(cleanup);

// jsdom n'implémente aucune API de défilement, alors que plusieurs composants en appellent une
// au montage (retour en haut du formulaire, dernier message d'un fil).
Element.prototype.scrollIntoView = () => {};
window.scrollTo = () => {};
